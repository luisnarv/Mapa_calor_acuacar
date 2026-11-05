import sys
from pathlib import Path

# El paquete `etl` vive en etl/etl: se agrega etl/ al path igual que hace run_etl.py.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
