from io import BytesIO
from types import SimpleNamespace

import numpy as np
import pytest
import torch
from fastapi import HTTPException, UploadFile

import main
from timestral import Forecast


CSV = b"date,value,label\n2024-01-01,10,a\n2024-01-02,20,b\n2024-01-03,30,c\n2024-01-04,40,d\n"


@pytest.fixture
def dataset(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "upload_folder", tmp_path)
    main.upload_doc(UploadFile(filename="series.csv", file=BytesIO(CSV)))
    calls = []

    def forecast(context, prediction_length, past_covariates=None):
        calls.append((context.copy(), prediction_length, None if past_covariates is None else past_covariates.copy()))
        median = torch.arange(prediction_length, dtype=torch.float32) + context[-1]
        quantiles = torch.stack([median - 2, median, median + 2], dim=-1)[None, None]
        return Forecast(quantiles, (0.1, 0.5, 0.9))

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(ml_model=SimpleNamespace(forecast=forecast))))
    return request, calls


def test_preview_returns_raw_values_without_inference(dataset):
    request, calls = dataset
    data = main.plot_values(request, main.Plot(value="value", x_axis="date"))
    assert data["value"] == [10, 20, 30, 40]
    assert data["x_axis"] == ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"]
    assert data["prediction"] == []
    assert calls == []


def test_only_selected_rows_reach_forecaster(dataset):
    request, calls = dataset
    data = main.plot_values(request, main.Plot(value="value", prediction=3), start_num=1, end_num=3)
    np.testing.assert_array_equal(calls[0][0], [20, 30])
    assert calls[0][1] == 3
    assert data["prediction"] == [30, 31, 32]
    assert data["lower"] == [28, 29, 30]
    assert data["upper"] == [32, 33, 34]
    assert data["value"] == [10, 20, 30, 40]
    assert calls[0][2] is None


def test_frontend_can_pass_date_selected_indices_in_chronological_order(dataset):
    request, calls = dataset
    main.plot_values(request, main.Plot(value="value", prediction=2, rows=[2, 0]))
    np.testing.assert_array_equal(calls[0][0], [30, 10])


@pytest.mark.parametrize("body,query", [
    ({"value": "missing"}, {}),
    ({"value": "label"}, {}),
    ({"value": "value", "x_axis": "missing"}, {}),
    ({"value": "value", "prediction": 0}, {}),
    ({"value": "value", "prediction": 1025}, {}),
    ({"value": "value", "prediction": 2, "rows": []}, {}),
    ({"value": "value", "prediction": 2, "rows": [-1]}, {}),
    ({"value": "value", "prediction": 2, "rows": [5]}, {}),
    ({"value": "value", "prediction": 2}, {"start_num": 2, "end_num": 1}),
    ({"value": "value", "prediction": 2}, {"start_num": -1}),
])
def test_invalid_requests_are_rejected_before_inference(dataset, body, query):
    request, calls = dataset
    with pytest.raises(HTTPException) as error:
        main.plot_values(request, main.Plot(**body), **query)
    assert error.value.status_code == 400
    assert calls == []


def test_upload_rejects_invalid_files_without_replacing_stored_data(dataset):
    for content in [b"", b"value\n", b"label\na\nb\n"]:
        with pytest.raises(HTTPException):
            main.upload_doc(UploadFile(filename="bad.csv", file=BytesIO(content)))
    assert main.get("value")["dates_value"] == [10, 20, 30, 40]


def test_missing_values_are_returned_as_null(dataset):
    request, _ = dataset
    main.upload_doc(UploadFile(filename="series.csv", file=BytesIO(b"value\n1\nNA\n3\n")))
    assert main.plot_values(request, main.Plot(value="value"))["value"] == [1, None, 3]
    with pytest.raises(HTTPException):
        main.plot_values(request, main.Plot(value="value", prediction=2), start_num=1, end_num=2)


def test_raw_column_endpoint_and_clear(dataset):
    assert main.get("date")["dates_value"][0] == "2024-01-01"
    with pytest.raises(HTTPException):
        main.get("missing")
    main.clear()
    with pytest.raises(HTTPException):
        main.get("date")


HELPERS_CSV = b"date,value,temp,wind,label\n2024-01-01,10,100,1,a\n2024-01-02,20,200,2,b\n2024-01-03,30,300,3,c\n2024-01-04,40,99999,99999,d\n"


def test_helpers_use_only_the_target_history_rows_without_future_leakage(dataset):
    request, calls = dataset
    main.upload_doc(UploadFile(filename="helpers.csv", file=BytesIO(HELPERS_CSV)))
    data = main.plot_values(request, main.Plot(value="value", prediction=2, helper_columns=["temp", "wind"]), start_num=1, end_num=3)
    np.testing.assert_array_equal(calls[0][0], [20, 30])
    np.testing.assert_array_equal(calls[0][2], [[[200, 300], [2, 3]]])
    assert data["prediction"] == [30, 31]


def test_helpers_follow_frontend_date_order_and_selected_column_order(dataset):
    request, calls = dataset
    main.upload_doc(UploadFile(filename="helpers.csv", file=BytesIO(HELPERS_CSV)))
    main.plot_values(request, main.Plot(value="value", prediction=2, rows=[2, 0], helper_columns=["wind", "temp"]))
    np.testing.assert_array_equal(calls[0][0], [30, 10])
    np.testing.assert_array_equal(calls[0][2], [[[3, 1], [300, 100]]])


@pytest.mark.parametrize("helpers", [["value"], ["missing"], ["label"], ["date"], ["temp", "temp"]])
def test_invalid_helper_columns_are_rejected_before_inference(dataset, helpers):
    request, calls = dataset
    main.upload_doc(UploadFile(filename="helpers.csv", file=BytesIO(HELPERS_CSV)))
    with pytest.raises(HTTPException) as error:
        main.plot_values(request, main.Plot(value="value", prediction=2, helper_columns=helpers))
    assert error.value.status_code == 400
    assert calls == []


@pytest.mark.parametrize("helper_values", ["NA\nNA", "inf\n2", "1\n-inf"])
def test_unusable_helper_history_is_rejected(dataset, helper_values):
    request, calls = dataset
    lines = helper_values.splitlines()
    csv = f"value,helper\n10,{lines[0]}\n20,{lines[1]}\n30,3\n".encode()
    main.upload_doc(UploadFile(filename="helpers.csv", file=BytesIO(csv)))
    with pytest.raises(HTTPException):
        main.plot_values(request, main.Plot(value="value", prediction=2, helper_columns=["helper"]), end_num=2)
    assert calls == []


def test_helpers_can_have_missing_values_and_invalid_future_rows_are_not_used(dataset):
    request, calls = dataset
    csv = b"value,helper\n10,1\n20,NA\n30,3\n40,inf\n"
    main.upload_doc(UploadFile(filename="helpers.csv", file=BytesIO(csv)))
    main.plot_values(request, main.Plot(value="value", prediction=2, helper_columns=["helper"]), end_num=3)
    np.testing.assert_array_equal(calls[0][2], [[[1, np.nan, 3]]])
