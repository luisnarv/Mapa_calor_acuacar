import sys
import re

with open('etl/eh_etl/clasificacion.py', 'r', encoding='utf-8') as f:
    text = f.read()

pattern = re.compile(r'if causal in \[\'ORDENES DE SUSPENSIÓN\', \'RECONEXIÓN IMPAGADOS\'\]:.*?# R1 \· la terna', re.DOTALL)

new_bypass = '''if causal in ['ORDENES DE SUSPENSIÓN', 'RECONEXIÓN IMPAGADOS']:
            if estado == 'APROBADA':
                return Veredicto('SUSPENDIDO', 'R0_acuacar', 'estado=Aprobada')
            elif estado in ('IMPOSIBILIDAD', 'RECHAZADA MOVILIDAD'):
                return Veredicto('NO ES POSIBLE SUSPENDER', 'R0_acuacar', f'estado={estado}')
            else:
                return Veredicto('SIN INFORMACIÓN', 'R0_acuacar', f'estado={estado}')

        # R1 · la terna'''

if pattern.search(text):
    text = pattern.sub(new_bypass, text)
    with open('etl/eh_etl/clasificacion.py', 'w', encoding='utf-8') as f:
        f.write(text)
    print('Patched bypass successfully')
else:
    print('Bypass pattern not found')
