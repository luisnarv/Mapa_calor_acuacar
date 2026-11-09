from fastapi import APIRouter

from app.api.v1.endpoints import openai

api_router = APIRouter()
api_router.include_router(openai.router, prefix="/openai", tags=["openai"])
