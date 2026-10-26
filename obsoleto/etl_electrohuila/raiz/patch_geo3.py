import sys

with open('etl/eh_etl/geografia.py', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace('sorted(set(self.zonas))', 'sorted(set(z for z in self.zonas if z is not None))')

with open('etl/eh_etl/geografia.py', 'w', encoding='utf-8') as f:
    f.write(text)
