from pathlib import Path
from fastapi import FastAPI, HTTPException, UploadFile
from shutil import copyfileobj
from uuid import uuid4
import pandas as pd
from timestral import TimestralForecaster
import torch
from contextlib import asynccontextmanager
from pydantic import BaseModel
from datetime import date
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

upload_folder = Path("app_data/uploads")
upload_folder.mkdir(parents=True,exist_ok=True)

class Plot(BaseModel):
    value: str
    x_axis: str | None = None
    prediction: int | None = None

@app.get("/")
def home():
    return {"health","ok"}


@app.post("/upload_doc")
def upload_doc(file: UploadFile):
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(
            status_code=400,
            detail="Upload a csv file"
        )

    #designed doc to be disposable(that is why file name does not change)
    name = f"disposable.csv"
    file_path = upload_folder/name

    with file_path.open("wb") as saved_file:
        copyfileobj(file.file, saved_file)

    df = pd.read_csv(file_path)
    col = list(df.columns)

    allowed_types = ["int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "float16", "float32", "float64"]
    allowed_col = []
    plot_against = []

    for c in col:
        t = df[c].dtype
        if t in allowed_types:
            allowed_col.append(c)
        else:
            plot_against.append(c)

    total_rows = df.shape[0]

    return {
        "status":"ok",
        "columns": allowed_col,
        "plot_against": plot_against,
        "total_rows": total_rows

    }

@app.post("/plot_values")
def plot_values(values: Plot, start_num: int | None = None, end_num: int | None = None, start_date: date | None = None, end_date: date | None = None):
    file_path =  Path("app_data/uploads/disposable.csv")

    if not file_path.exists():
        raise HTTPException(
            status_code=400,
            detail="No dataset has been uploaded"
        )

    df =  pd.read_csv(file_path)

    value = df[values.value].to_list()

    if values.value not in df.columns:
        raise HTTPException(
            status_code=400,
            detail=f"Value column '{values.value}' was not found",
        )
    
    if values.x_axis:
        if values.x_axis not in df.columns:
            raise HTTPException(
                status_code=400,
                detail=f"X-axis column '{values.x_axis}' was not found"
            )
    
        x_axis = df[values.x_axis].to_list()

    else:
        # use row numbers as the x axis
        x_axis = list(range(len(df)))



    return {
        "value": value,
        "x_axis": x_axis
    }

@app.post("/clear")
def clear():
    file_path =  Path("app_data/uploads/disposable.csv")

    if not file_path.exists():
        raise HTTPException(
            status_code=400,
            detail="No data to clear"
        )

    os.remove("app_data/uploads/disposable.csv")
    return {
        "message": "Data cleared succesfully"
    }


    

