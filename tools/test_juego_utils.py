"""Pruebas de las reglas del juego (funciones puras), sin Odoo.

    python3 tools/test_juego_utils.py

Los números de Carnes Primium son los de los pedidos reales usados en el
prototipo aprobado (típico $4,064, bronce $3,048, récord $4,396).
"""
import importlib.util
import pathlib
import unittest

ruta = pathlib.Path(__file__).resolve().parent.parent / "shalom_location_map/models/juego_utils.py"
spec = importlib.util.spec_from_file_location("juego_utils", ruta)
j = importlib.util.module_from_spec(spec)
spec.loader.exec_module(j)

PRIMIUM = [4395.89, 3438.88, 4042.32, 198.0, 4378.38, 52.8]


class TestJuego(unittest.TestCase):
    def test_referencias_primium(self):
        r = j.referencias_estrellas(PRIMIUM)
        self.assertEqual(r["n"], 6)
        self.assertAlmostEqual(r["record"], 4395.89)
        self.assertAlmostEqual(r["tipico"], 4063.87, places=2)
        self.assertAlmostEqual(r["t75"], 3047.90, places=2)

    def test_sin_historial(self):
        r = j.referencias_estrellas([])
        self.assertEqual(r["n"], 0)
        self.assertEqual(j.estrellas(500, r, 30), 0)
        self.assertIsNone(j.siguiente_objetivo(500, r, 30))

    def test_estrellas(self):
        r = j.referencias_estrellas(PRIMIUM)
        self.assertEqual(j.estrellas(2000, r, 25), 0)
        self.assertEqual(j.estrellas(3100, r, 25), 1)
        self.assertEqual(j.estrellas(4378, r, 22), 2)
        self.assertEqual(j.estrellas(4500, r, 22), 3)
        # supera el récord pero con margen bajo: el oro no cuenta
        self.assertEqual(j.estrellas(4500, r, 15), 2)

    def test_siguiente(self):
        r = j.referencias_estrellas(PRIMIUM)
        s = j.siguiente_objetivo(4378, r, 22)
        self.assertEqual(s["estrellas"], 3)
        self.assertAlmostEqual(s["faltan"], 18.0, places=0)
        s = j.siguiente_objetivo(4500, r, 10)
        self.assertTrue(s["margen_bajo"])
        self.assertIsNone(j.siguiente_objetivo(5000, r, 30))

    def test_un_solo_pedido(self):
        r = j.referencias_estrellas([1000])
        self.assertEqual(j.estrellas(1000, r, 30), 2)
        self.assertEqual(j.estrellas(1001, r, 30), 3)

    def test_clase(self):
        self.assertEqual(j.clasificar(0, 0, 0, 0), "NUEVO")
        self.assertEqual(j.clasificar(5, 900, 25, 40), "A")
        self.assertEqual(j.clasificar(5, 900, 15, 40), "A2")
        self.assertEqual(j.clasificar(5, 90, 25, 40), "B")
        self.assertEqual(j.clasificar(5, 90, 10, 40), "B2")
        self.assertEqual(j.clasificar(5, 900, 25, 200), "C")

    def test_valor_esperado(self):
        self.assertAlmostEqual(j.valor_esperado("A", 1000), 810.0)
        self.assertAlmostEqual(j.valor_esperado("C", 1000), 140.0)

    def test_xp_y_nivel(self):
        # utilidad $900, plata, día 3 -> 900*1.5 + 60
        self.assertEqual(j.xp_pedido(900, 2, 3), 1410)
        self.assertEqual(j.xp_pedido(900, 2, 20), 960)
        self.assertEqual(j.xp_pedido(-50, 0, 20), 0)
        self.assertEqual(j.nivel_de_xp(0)[0], 1)
        self.assertEqual(j.nivel_de_xp(600)[0], 2)
        self.assertEqual(j.nivel_de_xp(999999)[3], None)


def _clientes(n, esperado=500.0, clase="A"):
    return [{"id": i, "orden": i, "clase": clase, "esperado": esperado} for i in range(1, n + 1)]


class TestCarteras(unittest.TestCase):
    def test_dos_vendedores_no_comparten(self):
        # 20 clientes de $500 = $10,000: alcanza para 2 vendedores
        cands = [
            {"id": i, "orden": i, "clase": "A" if i % 2 else "B", "esperado": 1000.0 if i % 2 else 150.0}
            for i in range(1, 25)
        ]
        carteras = j.repartir_carteras(cands, 2, minimo=2000, reserva_n=2)
        vistos = []
        for c in carteras:
            vistos += c["items"] + c["reservas"]
        self.assertEqual(len(vistos), len(set(vistos)))
        self.assertEqual({c["persona"] for c in carteras}, {0, 1})
        for c in carteras[:-1]:
            self.assertGreaterEqual(c["esperado"], 2000)
            self.assertTrue(c["completo"])
        # los dos turnos del día 0 son vecinos en la ruta
        self.assertEqual(carteras[0]["dia"], 0)
        self.assertEqual(carteras[1]["dia"], 0)
        self.assertEqual(max(carteras[0]["items"] + carteras[0]["reservas"]) + 1,
                         min(carteras[1]["items"] + carteras[1]["reservas"]))
        # llegan al mínimo SIN contar la reserva, y la reserva son los de menor valor
        self.assertTrue(all(c["completo"] for c in carteras))
        self.assertTrue(any(c["reservas"] for c in carteras))
        for c in carteras:
            for r in c["reservas"]:
                self.assertEqual(r % 2, 0)  # los B de $150

    def test_ruta_chica_usa_un_solo_vendedor(self):
        # $2,500 en total: no alcanza para dos carteras de $2,000
        carteras = j.repartir_carteras(_clientes(5), 2, minimo=2000, reserva_n=0)
        self.assertEqual({c["persona"] for c in carteras}, {0})

    def test_orden_a_antes_que_b(self):
        cands = [
            {"id": 1, "orden": 1, "clase": "B", "esperado": 1000},
            {"id": 2, "orden": 2, "clase": "A", "esperado": 1000},
            {"id": 3, "orden": 3, "clase": "A2", "esperado": 1000},
        ]
        c = j.repartir_carteras(cands, 1, minimo=2500, reserva_n=0)[0]
        self.assertEqual(c["items"], [2, 3, 1])

    def test_dormidos_y_nuevos_fuera(self):
        cands = _clientes(3, 1000) + [
            {"id": 9, "orden": 9, "clase": "C", "esperado": 140},
            {"id": 10, "orden": 10, "clase": "NUEVO", "esperado": 0},
        ]
        todos = [i for c in j.repartir_carteras(cands, 1, 2000, 0) for i in c["items"] + c["reservas"]]
        self.assertNotIn(9, todos)
        self.assertNotIn(10, todos)

    def test_reparto_parejo(self):
        # $5,000 y 2 vendedores: dos carteras de ~$2,500, ninguna bajo $2,000
        carteras = j.repartir_carteras(_clientes(10), 2, minimo=2000, reserva_n=0)
        self.assertEqual(len(carteras), 2)
        self.assertTrue(all(c["esperado"] >= 2000 for c in carteras))

    def test_reserva_no_baja_del_minimo(self):
        # 4 clientes de $500 = $2,000 justos: no se puede sacar reserva
        c = j.repartir_carteras(_clientes(4), 1, minimo=2000, reserva_n=3)[0]
        self.assertEqual(c["reservas"], [])
        self.assertTrue(c["completo"])

    def test_poco_valor_queda_incompleta(self):
        c = j.repartir_carteras(_clientes(2), 1, minimo=2000, reserva_n=0)[0]
        self.assertFalse(c["completo"])

    def test_vacio(self):
        self.assertEqual(j.repartir_carteras([], 2), [])

    def test_deterministico_con_orden_repetido(self):
        cands = [{"id": i, "orden": 0, "clase": "A", "esperado": 700.0} for i in range(1, 9)]
        a = j.repartir_carteras(cands, 2, 2000, 0)
        b = j.repartir_carteras(list(reversed(cands)), 2, 2000, 0)
        self.assertEqual(a, b)


class TestLogros(unittest.TestCase):
    def _stats(self, **kw):
        base = {"n_pedidos": 0, "n_quimico": 0, "mejor_racha": 0, "max_estrellas": 0,
                "hay_record": False, "mayor_pedido": 0, "xp_total": 0}
        base.update(kw)
        return base

    def _por_codigo(self, stats):
        return {l["codigo"]: l for l in j.estado_logros(stats)}

    def test_catalogo_minimo_y_bienvenida_suma_600(self):
        codigos = {l["codigo"] for l in j.LOGROS}
        for c in ("primer_pedido", "quimico", "ruta_sin_saltos", "primera_plata", "oro", "record_roto", "nivel_2"):
            self.assertIn(c, codigos)
        self.assertEqual(len(codigos), len(j.LOGROS))  # sin códigos repetidos
        # Las 3 misiones del tutorial valen justo el nivel 2 (600 XP)
        self.assertEqual(sum(l["xp"] for l in j.LOGROS if l["bienvenida"]), j.NIVELES[1][2])

    def test_sin_actividad_nada_completo(self):
        est = j.estado_logros(self._stats())
        self.assertFalse(any(l["completo"] for l in est))
        self.assertTrue(all(l["progreso"] == 0 for l in est))

    def test_progreso_y_tope(self):
        e = self._por_codigo(self._stats(n_pedidos=4, n_quimico=2, mejor_racha=9, xp_total=450))
        self.assertTrue(e["primer_pedido"]["completo"])
        self.assertEqual((e["quimico"]["progreso"], e["quimico"]["meta"], e["quimico"]["completo"]), (2, 3, False))
        # el progreso nunca pasa de la meta
        self.assertEqual((e["ruta_sin_saltos"]["progreso"], e["ruta_sin_saltos"]["completo"]), (5, True))
        self.assertEqual((e["nivel_2"]["progreso"], e["nivel_2"]["completo"]), (450, False))

    def test_estrellas_y_record(self):
        e = self._por_codigo(self._stats(max_estrellas=2))
        self.assertTrue(e["primera_plata"]["completo"])
        self.assertFalse(e["oro"]["completo"])
        e = self._por_codigo(self._stats(max_estrellas=3, hay_record=True, mayor_pedido=2000.01, xp_total=600))
        self.assertTrue(all(e[c]["completo"] for c in ("primera_plata", "oro", "record_roto", "cazador_grandes", "nivel_2")))
        # exactamente $2,000 no es "más de $2,000"
        self.assertFalse(self._por_codigo(self._stats(mayor_pedido=2000.0))["cazador_grandes"]["completo"])

    def test_racha(self):
        self.assertEqual(j.racha_mas_larga([]), 0)
        self.assertEqual(j.racha_mas_larga([1, 1, 1, 1, 1]), 5)
        self.assertEqual(j.racha_mas_larga([1, 1, 2, 1, 1, 1]), 3)         # otra ruta en medio corta
        self.assertEqual(j.racha_mas_larga([1, 1, False, 1, 1, 1]), 3)     # ruta desconocida corta
        self.assertEqual(j.racha_mas_larga([None, None]), 0)

    def test_tinte_y_oxigenta(self):
        self.assertTrue(j.es_tinte("TINTE Rubio 8.0"))
        self.assertTrue(j.es_tinte("Rubio 8.0", "Tintes"))
        self.assertFalse(j.es_tinte("Shampoo", "Cuidado"))
        self.assertTrue(j.es_oxigenta("Oxigenta 40 vol"))
        self.assertTrue(j.es_oxigenta("OXÍGENTA crema"))     # tildes y mayúsculas
        self.assertTrue(j.es_oxigenta("Agua", "Oxidantes"))
        self.assertEqual(j.pedido_con_tinte_y_oxigenta([("Tinte A", ""), ("Oxigenta 20", "")]), (True, True))
        self.assertEqual(j.pedido_con_tinte_y_oxigenta([("Tinte A", "")]), (True, False))
        self.assertEqual(j.pedido_con_tinte_y_oxigenta([]), (False, False))


class TestEquipo(unittest.TestCase):
    def test_dias_habiles(self):
        from datetime import date
        # noviembre 2026: 1 nov es domingo; 30 días, 21 hábiles (lun-vie)
        self.assertEqual(j.dias_habiles_entre(date(2026, 11, 1), date(2026, 11, 30)), 21)
        self.assertEqual(j.dias_habiles_entre(date(2026, 11, 7), date(2026, 11, 8)), 0)  # sáb-dom
        self.assertEqual(j.dias_habiles_entre(date(2026, 11, 5), date(2026, 11, 4)), 0)  # rango al revés

    def test_ritmo_a_mitad_de_mes(self):
        from datetime import date
        r = j.ritmo_equipo(41900, 60000, 80000, date(2026, 11, 16))  # lunes
        self.assertEqual(r["dias_mes"], 30)
        self.assertEqual(r["dias_habiles_mes"], 21)
        self.assertEqual(r["dias_habiles_pasados"], 10)       # del 2 al 13
        self.assertEqual(r["dias_habiles_restantes"], 11)     # del 16 al 30, hoy incluido
        self.assertEqual(r["faltan_piso"], 18100.0)
        self.assertEqual(r["faltan_meta"], 38100.0)
        self.assertAlmostEqual(r["ritmo_piso"], 18100 / 11, places=2)
        self.assertAlmostEqual(r["pct_piso"], 69.8, places=1)
        self.assertFalse(r["piso_alcanzado"])
        self.assertAlmostEqual(r["esperado_hoy"], 60000 * 10 / 21, places=2)
        self.assertTrue(r["en_ritmo"])                        # 41,900 >= 28,571 esperados al día 16
        self.assertNotIn("vendedores", r)

    def test_en_ritmo_y_metas_alcanzadas(self):
        from datetime import date
        r = j.ritmo_equipo(85000, 60000, 80000, date(2026, 11, 20))
        self.assertTrue(r["piso_alcanzado"] and r["meta_alcanzada"] and r["en_ritmo"])
        self.assertEqual((r["faltan_piso"], r["faltan_meta"], r["ritmo_piso"]), (0.0, 0.0, 0.0))

    def test_ultimo_dia_y_fin_de_semana(self):
        from datetime import date
        # sábado 28 nov: quedan 1 hábil (lun 30) -> todo el faltante en un día
        r = j.ritmo_equipo(50000, 60000, 80000, date(2026, 11, 28))
        self.assertEqual(r["dias_habiles_restantes"], 1)
        self.assertEqual(r["ritmo_piso"], 10000.0)
        # domingo 31 ene 2027 sin hábiles restantes: divide entre 1, no entre 0
        r = j.ritmo_equipo(0, 60000, 80000, date(2027, 1, 31))
        self.assertEqual(r["dias_habiles_restantes"], 0)
        self.assertEqual(r["ritmo_piso"], 60000.0)

    def test_sin_parametros_no_revienta(self):
        from datetime import date
        r = j.ritmo_equipo(1000, 0, 0, date(2026, 11, 5))
        self.assertEqual((r["pct_piso"], r["pct_meta"]), (0.0, 0.0))
        self.assertFalse(r["piso_alcanzado"])

    def test_camion(self):
        self.assertIsNone(j.camion_del_dia(500, None))
        self.assertIsNone(j.camion_del_dia(500, 0))
        self.assertIsNone(j.camion_del_dia(500, "abc"))
        self.assertIsNone(j.camion_del_dia(500, -5))
        c = j.camion_del_dia(10500, "9000")
        self.assertEqual((c["meta"], c["vendido"], c["lleno"]), (9000.0, 10500.0, True))
        self.assertAlmostEqual(c["pct"], 116.7, places=1)
        self.assertFalse(j.camion_del_dia(100, 9000)["lleno"])


class TestTemporada(unittest.TestCase):
    def test_hitos(self):
        nivel, hitos = j.hitos_temporada(0)
        self.assertEqual((nivel, len(hitos)), (0, 12))
        self.assertTrue(hitos[0]["actual"] and not hitos[0]["alcanzado"])
        nivel, hitos = j.hitos_temporada(j.HITOS_TEMPORADA[2])     # justo en el 3º
        self.assertEqual(nivel, 3)
        self.assertEqual([h["alcanzado"] for h in hitos[:4]], [True, True, True, False])
        self.assertEqual([h["nivel"] for h in hitos if h["actual"]], [4])
        nivel, hitos = j.hitos_temporada(10 ** 6)
        self.assertEqual(nivel, 12)
        self.assertFalse(any(h["actual"] for h in hitos))          # ya no hay siguiente
        self.assertEqual(sorted(j.HITOS_TEMPORADA), j.HITOS_TEMPORADA)

    def test_premios(self):
        self.assertEqual(j.premios_de_texto(""), {})
        self.assertEqual(j.premios_de_texto(None), {})
        self.assertEqual(j.premios_de_texto("   "), {})
        self.assertEqual(j.premios_de_texto("{no es json"), {})
        self.assertEqual(j.premios_de_texto("42"), {})
        self.assertEqual(j.premios_de_texto('{"4": "Cena", "7": " ", "99": "x", "z": "y"}'), {4: "Cena"})
        self.assertEqual(j.premios_de_texto('[{"nivel": 6, "texto": "Marco"}, {"nivel": 1}, "raro"]'), {6: "Marco"})

    def test_quincena(self):
        from datetime import date
        self.assertEqual(j.dias_quincena_restantes(date(2026, 11, 1)), 15)
        self.assertEqual(j.dias_quincena_restantes(date(2026, 11, 12)), 4)
        self.assertEqual(j.dias_quincena_restantes(date(2026, 11, 15)), 1)
        self.assertEqual(j.dias_quincena_restantes(date(2026, 11, 16)), 0)


if __name__ == "__main__":
    unittest.main()
