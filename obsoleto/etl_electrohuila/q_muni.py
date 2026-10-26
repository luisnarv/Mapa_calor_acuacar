import psycopg2
conn=psycopg2.connect('host=dbtraceopsproduccion.ch1riez4g3n7.us-west-2.rds.amazonaws.com port=5432 dbname=postgres user=usr_analitica password=eP3ucgnJPw5tTn3P')
cur=conn.cursor()
cur.execute("SELECT sector, COUNT(*) FROM dbanalitica.historico_acuacar_scr GROUP BY sector LIMIT 10;")
print(cur.fetchall())
