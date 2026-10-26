import psycopg2
import pandas as pd

conn = psycopg2.connect('host=dbtraceopsproduccion.ch1riez4g3n7.us-west-2.rds.amazonaws.com port=5432 dbname=postgres user=usr_analitica password=eP3ucgnJPw5tTn3P')
df = pd.read_sql("SELECT REGEXP_REPLACE(subsector, '-[0-9]+$', '')::TEXT AS nombre_muni, count(*) FROM dbanalitica.historico_acuacar_scr GROUP BY nombre_muni LIMIT 10", conn)
print(df)
