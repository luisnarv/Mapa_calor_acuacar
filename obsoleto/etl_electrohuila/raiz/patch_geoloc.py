import sys

with open('etl/eh_etl/geolocalizar.py', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace('if duplicados:', 'print("Candidatos de SANTA LUCIA:", candidatos.get("SANTA LUCIA"))\n    if duplicados:')

with open('etl/eh_etl/geolocalizar.py', 'w', encoding='utf-8') as f:
    f.write(text)
