"""Axio Web: el mismo buscador de axio/dominio, servido por navegador.

No duplica lógica de negocio: todo lo que decide qué es un resultado, de qué color va un
pago o quién es el encargado de Cartera sigue viviendo en axio/dominio. Aquí solo hay
estado compartido entre usuarios (web/servicio.py), usuarios (web/usuarios.py) y HTTP
(web/app.py).
"""
