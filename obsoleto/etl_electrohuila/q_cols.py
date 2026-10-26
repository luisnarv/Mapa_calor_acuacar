import psycopg2
conn=psycopg2.connect('host=dbtraceopsproduccion.ch1riez4g3n7.us-west-2.rds.amazonaws.com port=5432 dbname=postgres user=usr_analitica password=eP3ucgnJPw5tTn3P')
cur=conn.cursor()
cur.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='dbanalitica' AND table_name='historico_acuacar_scr';")
print([r[0] for r in cur.fetchall()])
