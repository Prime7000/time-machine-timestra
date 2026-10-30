from pathlib import Path
from fastapi import FastAPI, HTTPException, UploadFile, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from shutil import copyfileobj
import pandas as pd
from timestral import TimestralForecaster
import torch
from contextlib import asynccontextmanager
from pydantic import BaseModel
import os


@asynccontextmanager
async def lifespan(app: FastAPI):
    model = TimestralForecaster.from_pretrained(
        "./models/Timestral-209M",
        device="cuda" if torch.cuda.is_available() else "cpu")

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

    col = list(df.columns)
    allowed_col = []
    plot_against = []
    for c in col:
        if pd.api.types.is_numeric_dtype(df[c]):
            allowed_col.append(c)
        else:
            plot_against.append(c)
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

    prediction = []
    lower = []
    upper = []
    if values.prediction is not None:
        if not 1 <= values.prediction <= 1024:
            raise HTTPException(status_code=400, detail="Prediction must be between 1 and 1024 steps")
        if values.rows is not None:
            if not values.rows or min(values.rows) < 0 or max(values.rows) >= len(df):
                raise HTTPException(status_code=400, detail="Selected rows are outside the dataset")
            context = df[values.value].iloc[values.rows]
        else:
            start = start_num if start_num is not None else 0
            end = end_num if end_num is not None else len(df)
            if start < 0 or start >= end or end > len(df):
                raise HTTPException(status_code=400, detail="Select a valid row range")
            context = df[values.value].iloc[start:end]
        if context.isna().all() or context.isin([float("inf"), float("-inf")]).any():
            raise HTTPException(status_code=400, detail="The selected history needs finite numeric values")

        model = request.app.state.ml_model
        forecast = model.forecast(context.to_numpy(dtype=float, copy=True), prediction_length=values.prediction)
        prediction = forecast.median.flatten().tolist()
        lower = forecast.quantile(0.1).flatten().tolist()
        upper = forecast.quantile(0.9).flatten().tolist()

    df = df.replace([float("inf"), float("-inf")], None)
    value = [None if pd.isna(v) else v for v in df[values.value].to_list()]
    x_axis = df[values.x_axis].to_list() if values.x_axis else list(range(len(df)))
    x_axis = [None if pd.isna(v) else v for v in x_axis]
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
    data = [None if pd.isna(v) else v for v in df[date_col].replace([float("inf"), float("-inf")], None).to_list()]
    return {"dates_value": data}


@app.post("/clear")
def clear():
    file_path = upload_folder / "disposable.csv"
    if not file_path.exists():
        raise HTTPException(status_code=400, detail="No data to clear")

    os.remove(file_path)
    return {"message": "Data cleared successfully"}
