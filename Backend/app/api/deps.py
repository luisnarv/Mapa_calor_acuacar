"""Dependencias que se inyectan en los endpoints."""

from typing import Annotated

from fastapi import Depends

from app.core.config import settings
from app.services.metrics_service import MetricsService
from app.services.openai_service import OpenAIService, get_openai_service
from app.services.tools import ToolRunner


def get_tool_runner() -> ToolRunner:
    """Las herramientas que el modelo puede invocar, atadas a esta petición.

    `MetricsService` no guarda estado propio: el payload vive cacheado en `payload_store`.
    """
    return ToolRunner(MetricsService(settings.DATA_DIR))


ToolRunnerDep = Annotated[ToolRunner, Depends(get_tool_runner)]
OpenAIServiceDep = Annotated[OpenAIService, Depends(get_openai_service)]
