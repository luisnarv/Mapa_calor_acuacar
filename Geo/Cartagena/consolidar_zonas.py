import pandas as pd, unicodedata

df = pd.read_excel("Tarifas_nuevas_sin_  - Zona Rural .xlsx", 
                   sheet_name=0, header=None, skipfooter=1, usecols=[0,1], names=["ZONA","BARRIO"])

def key (s):
    if pd.isna(s):return ""
    s = unicodedata.normalize("NFD", str(s))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return "".join(ch for ch in s.upper() if ch.isalnum())

df["ZONA"] = df["ZONA"].astype(str).str.strip().str.upper()
df["k"] = df["BARRIO"].map(key)

df = df[(df["ZONA"] != "") & (df["k"] != "")].drop_duplicates(["ZONA","k"])

antes = df["k"].nunique()
df = df.drop_duplicates("k", keep="first")

df[["ZONA","BARRIO","k"]].to_csv("zona_barrio_limpio.csv", index=False, encoding="utf-8")

print(f"{len(df)} barrios | zonas: {sorted(df['ZONA'].unique())}")
print(f"conflictos resueltos (barrios que estaban en varias zonas): {antes - df['k'].nunique() if False else 'ver abajo'}")
mult = df["k"].value_counts()
print("barrios en 2+ zonas tras limpiar:", int((mult > 1).sum()), "(debe ser 0)")