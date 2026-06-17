"""Schemas de produtos."""

from typing import Optional

from pydantic import BaseModel


class ProductCreate(BaseModel):
    name: str
    description: str = ""
    price: float
    stock: int = 0
    unit: str = "unidade"


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    price: Optional[float] = None
    stock: Optional[int] = None
    unit: Optional[str] = None


class ProductInfo(BaseModel):
    id: int
    name: str
    description: str = ""
    price: float
    stock: int = 0
    unit: str = "unidade"
