from pathlib import Path
from fastapi import FastAPI, HTTPException, UploadFile, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from shutil import copyfileobj
from math import isfinite
import pandas as pd
from timestral import TimestralForecaster
import torch
from contextlib import asynccontextmanager
from pydantic import BaseModel, Field
import os


@asynccontextmanager
async def lifespan(app: FastAPI):
    device = "cpu"
    if torch.cuda.is_available():
        device = "cuda"

    model = TimestralForecaster.from_pretrained(
        "./models/Timestral-209M",
        device=device,
    )

    app.state.ml_model = model
    print("----------model fully loaded--------------")
    yield
    print("------------program is closing-------------")


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")

upload_folder = Path("app_data/uploads")
upload_folder.mkdir(parents=True, exist_ok=True)


class Plot(BaseModel):
    value: str
    x_axis: str | None = None
    prediction: int | None = None
    rows: list[int] | None = None
    helper_columns: list[str] = Field(default_factory=list)


def valid_history(column):
    """Allow missing cells, but require a number and reject infinities."""
    found_number = False
    for number in column.to_list():
        if pd.isna(number):
            continue
        if not isfinite(number):
            return False
        found_number = True
    return found_number


def column_values(column):
    """Turn missing cells and infinities into JSON null values."""
    column = column.replace([float("inf"), float("-inf")], None)
    result = []
    for value in column.to_list():
        if pd.isna(value):
            value = None
        result.append(value)
    return result


@app.get("/")
def home():
    return FileResponse(Path(__file__).parent / "static/index.html")


@app.post("/upload_doc")
def upload_doc(file: UploadFile):
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Upload a csv file")

    try:
        df = pd.read_csv(file.file)
    except (pd.errors.EmptyDataError, pd.errors.ParserError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="The CSV is empty or could not be read")
    if df.empty:
        raise HTTPException(status_code=400, detail="The CSV has no data rows")

    allowed_col = []
    plot_against = []
    for column in df.columns:
        if pd.api.types.is_numeric_dtype(df[column]):
            allowed_col.append(column)
        else:
            plot_against.append(column)
    if not allowed_col:
        raise HTTPException(status_code=400, detail="The CSV needs a numeric column")

    # Designed to be disposable: each upload replaces the previous file.
    file_path = upload_folder / "disposable.csv"
    file.file.seek(0)
    with file_path.open("wb") as saved_file:
        copyfileobj(file.file, saved_file)

    return {
        "status": "ok",
        "columns": allowed_col,
        "plot_against": plot_against,
        "total_rows": df.shape[0],
    }


@app.post("/plot_values")
def plot_values(request: Request, values: Plot, start_num: int | None = None, end_num: int | None = None):
    file_path = upload_folder / "disposable.csv"
    if not file_path.exists():
        raise HTTPException(status_code=400, detail="No dataset has been uploaded")

    df = pd.read_csv(file_path)
    if values.value not in df.columns:
        raise HTTPException(status_code=400, detail=f"Value column '{values.value}' was not found")
    if not pd.api.types.is_numeric_dtype(df[values.value]):
        raise HTTPException(status_code=400, detail="Select a numeric value column")
    if values.x_axis and values.x_axis not in df.columns:
        raise HTTPException(status_code=400, detail=f"X-axis column '{values.x_axis}' was not found")
    selected_helpers = []
    for column in values.helper_columns:
        if column in selected_helpers:
            raise HTTPException(status_code=400, detail="Select each helper column only once")
        selected_helpers.append(column)

    for column in values.helper_columns:
        if column == values.value:
            raise HTTPException(status_code=400, detail="The value being predicted cannot also be a helper")
        if column not in df.columns:
            raise HTTPException(status_code=400, detail=f"Helper column '{column}' must be a numeric column in the dataset")
        if not pd.api.types.is_numeric_dtype(df[column]):
            raise HTTPException(status_code=400, detail=f"Helper column '{column}' must be a numeric column in the dataset")

    prediction = []
    lower = []
    upper = []
    if values.prediction is not None:
        if values.prediction < 1 or values.prediction > 1024:
            raise HTTPException(status_code=400, detail="Prediction must be between 1 and 1024 steps")
        if values.rows is not None:
            if not values.rows:
                raise HTTPException(status_code=400, detail="Selected rows are outside the dataset")
            for row in values.rows:
                if row < 0 or row >= len(df):
                    raise HTTPException(status_code=400, detail="Selected rows are outside the dataset")
            history = df.iloc[values.rows]
        else:
            start = 0
            end = len(df)
            if start_num is not None:
                start = start_num
            if end_num is not None:
                end = end_num
            if start < 0 or start >= end or end > len(df):
                raise HTTPException(status_code=400, detail="Select a valid row range")
            history = df.iloc[start:end]
        context = history[values.value]
        if not valid_history(context):
            raise HTTPException(status_code=400, detail="The selected history needs finite numeric values")

        past_covariates = None
        if values.helper_columns:
            helpers = history[values.helper_columns]
            for column in values.helper_columns:
                if not valid_history(helpers[column]):
                    raise HTTPException(status_code=400, detail="Each helper needs finite numeric values in the selected history")
            # Use exactly the same historical rows and order as the target.
            helper_numbers = helpers.to_numpy(dtype=float, copy=True)
            helper_numbers = helper_numbers.transpose()
            # Shape: one series, helper columns, history rows.
            past_covariates = helper_numbers.reshape(1, len(values.helper_columns), len(history))

        model = request.app.state.ml_model
        context_numbers = context.to_numpy(dtype=float, copy=True)
        forecast = model.forecast(
            context_numbers,
            prediction_length=values.prediction,
            past_covariates=past_covariates,
        )
        median_values = forecast.median
        median_values = median_values.flatten()
        prediction = median_values.tolist()
        lower_values = forecast.quantile(0.1)
        lower_values = lower_values.flatten()
        lower = lower_values.tolist()
        upper_values = forecast.quantile(0.9)
        upper_values = upper_values.flatten()
        upper = upper_values.tolist()

    value = column_values(df[values.value])
    if values.x_axis:
        x_axis = column_values(df[values.x_axis])
    else:
        x_axis = list(range(len(df)))
    return {
        "value": value,
        "x_axis": x_axis,
        "prediction": prediction,
        "lower": lower,
        "upper": upper,
    }


@app.get("/get_date")
def get(date_col: str):
    file_path = upload_folder / "disposable.csv"
    if not file_path.exists():
        raise HTTPException(status_code=400, detail="No data to fetch date from")

    df = pd.read_csv(file_path)
    if date_col not in df.columns:
        raise HTTPException(status_code=400, detail="Column was not found")
    data = column_values(df[date_col])
    return {"dates_value": data}


@app.post("/clear")
def clear():
    file_path = upload_folder / "disposable.csv"
    if not file_path.exists():
        raise HTTPException(status_code=400, detail="No data to clear")

    os.remove(file_path)
    return {"message": "Data cleared successfully"}
