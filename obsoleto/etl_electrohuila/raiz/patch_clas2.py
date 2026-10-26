import sys

with open('etl/eh_etl/clasificacion.py', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace('SIN INFORMACI"N', 'SIN INFORMACIÓN')

with open('etl/eh_etl/clasificacion.py', 'w', encoding='utf-8') as f:
    f.write(text)
