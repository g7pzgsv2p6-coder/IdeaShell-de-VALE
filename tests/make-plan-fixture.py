"""Crea un plan de trabajo FICTICIO (.xlsx) con la misma estructura de hojas que usa la app.
Uso: python3 tests/make-plan-fixture.py salida.xlsx
Las fechas se calculan desde hoy para que haya actividades atrasadas, de hoy y futuras."""
import sys
from datetime import date, timedelta, datetime
from openpyxl import Workbook

out = sys.argv[1]
today = date.today()
start = today - timedelta(days=today.weekday()) - timedelta(days=0)  # lunes de esta semana
if start == today:
    start = today - timedelta(days=7)  # si hoy es lunes, el plan parte la semana anterior
end = start + timedelta(days=24)
holiday = start + timedelta(days=22)

wb = Workbook()
ws = wb.active
ws.title = 'Resumen'
ws.append(['EMPRESA DEMO · Plan de trabajo Ana Pérez · Cliente Ficticio SpA'])
ws.append(['Plan de Trabajo – Demo 25 días'])
ws.append(['Tablero de avance'])
ws.append(['Prestadora', 'Ana Pérez · coordinadora'])
ws.append(['Contraparte', 'Beatriz Soto · jefa de proyecto · valida entregables'])
ws.append(['Período', f'25 días · {start:%d/%m} al {end:%d/%m/%Y} · feriado {holiday:%d/%m/%Y} (feriado)'])
ws.append(['Régimen', 'Lunes a jueves presencial · viernes remoto'])
ws.append(['FRENTE', 'PESO', 'PLANIFICADO A HOY', 'AVANCE REAL'])
ws.append(['A. Operaciones', 0.5, 0, 0])
ws.append(['B. Comercial', 0.3, 0, 0])
ws.append(['C. Reportes', 0.2, 0, 0])
ws.append(['AVANCE PONDERADO', 1, 0, 0])

wa = wb.create_sheet('Actividades')
wa.append(['EMPRESA DEMO'])
wa.append(['Plan día a día'])
wa.append(['Se actualiza a mano'])
wa.append(['ID', 'SEM', 'FECHA', 'DÍA', 'MODALIDAD', 'FRENTE', 'ACTIVIDAD', 'CON QUIÉN', 'ENTREGABLE', 'ESTADO', '% AVANCE', 'FECHA REAL', 'DÍAS ATRASO', 'OBSERVACIONES / BLOQUEOS'])
acts = [
    (0, 'C', 'Reunión de arranque con Beatriz', 'Beatriz', 'Acta de arranque'),
    (0, 'A', 'Recorrido por la bodega central', 'Carlos Rivas', '—'),
    (1, 'A', 'Inventario de equipos críticos', 'Carlos Rivas', 'Inventario v1'),
    (2, 'B', 'Revisar cartera de clientes', 'Diana', '—'),
    (3, 'B', 'Preparar propuesta comercial', 'Beatriz', 'Propuesta borrador'),
    (4, 'C', 'Enviar reporte semanal 1', 'Beatriz', 'Reporte semanal 1'),
    (7, 'A', 'Planificación semanal con Beatriz', 'Beatriz', 'Prioridades'),
    (8, 'A', 'Verificar permisos vigentes', 'Carlos', 'Matriz de permisos'),
    (9, 'B', 'Visitar 3 clientes potenciales', 'Diana Fuentes', 'Registro de visitas'),
    (10, 'A', 'Cotizar repuestos con 4 proveedores', 'Carlos Rivas', 'Cuadro comparativo'),
    (11, 'C', 'Enviar reporte semanal 2', 'Beatriz', 'Reporte semanal 2'),
    (14, 'A', 'Cerrar matriz de permisos', 'Carlos Rivas', 'Matriz final'),
    (16, 'B', 'Seguimiento de propuestas enviadas', 'Diana Fuentes', 'Estado de propuestas'),
    (18, 'C', 'Informe mensual', 'Beatriz', 'Informe mensual'),
    (21, 'C', 'Reunión de cierre', 'Beatriz', 'Acta de cierre'),
]
for i, (off, fr, title, who, deliv) in enumerate(acts, 1):
    d = start + timedelta(days=off)
    mode = 'Remoto' if d.weekday() == 4 else 'Presencial'
    wa.append([f'T{i:02d}', off // 7 + 1, datetime(d.year, d.month, d.day), ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'][d.weekday()], mode, fr, title, who, deliv, 'Pendiente', 0, None, None, None])

we = wb.create_sheet('Entregables')
we.append(['EMPRESA DEMO'])
we.append(['Calendario de entregables'])
we.append(['Notas'])
we.append(['ID', 'ENTREGABLE', 'FRENTE', 'FECHA COMPROMETIDA', 'VALIDA', 'CARPETA SHAREPOINT', 'ESTADO', 'FECHA ENTREGA', 'DÍAS ATRASO', 'OBSERVACIONES'])
dels = [(0, 'Acta de arranque', 'C', 'Beatriz'), (1, 'Inventario de equipos v1', 'A', 'Carlos Rivas'), (4, 'Reporte semanal 1', 'C', 'Beatriz'),
        (10, 'Cuadro comparativo de repuestos', 'A', 'Beatriz / Carlos Rivas'), (11, 'Reporte semanal 2', 'C', 'Beatriz'), (18, 'Informe mensual', 'C', 'Beatriz')]
for i, (off, name, fr, by) in enumerate(dels, 1):
    d = start + timedelta(days=off)
    we.append([f'E{i:02d}', name, fr, datetime(d.year, d.month, d.day), by, f'0{i}_DOC', 'Pendiente', None, None, None])

wl = wb.create_sheet('Bitácora')
wl.append(['EMPRESA DEMO'])
wl.append(['Bitácora diaria'])
wl.append(['Se completa al cierre'])
wl.append(['FECHA', 'DÍA', 'REUNIONES SOSTENIDAS', 'ACUERDOS Y RESPONSABLES', 'DOCUMENTOS RECIBIDOS', 'ALERTAS / ESCALAMIENTOS', 'PENDIENTES PARA MAÑANA', 'ENVIADA'])
for off in (0, 1, 2, 3, 7, 8):
    d = start + timedelta(days=off)
    wl.append([datetime(d.year, d.month, d.day), 'Día', 'Ej.: reunión de ejemplo' if off == 0 else None, None, None, None, None, None])

wm = wb.create_sheet('Metas')
wm.append(['EMPRESA DEMO'])
wm.append(['Metas del mes'])
wm.append(['Real vs meta'])
wm.append(['FRENTE', 'INDICADOR', 'META', 'REAL', '% CUMPLIMIENTO', 'FECHA META', 'FUENTE DE VERIFICACIÓN'])
for fr, ind, meta, off in [('A', 'Equipos críticos inventariados', 20, 10), ('A', 'Permisos con estado y evidencia (%)', 1, 14), ('B', 'Clientes visitados', 3, 9), ('C', 'Reportes semanales entregados', 2, 11)]:
    d = start + timedelta(days=off)
    wm.append([fr, ind, meta, 0, 0, datetime(d.year, d.month, d.day), 'Hoja de control'])

wr = wb.create_sheet('Referencia')
wr.append(['EMPRESA DEMO'])
wr.append(['Semana tipo, reglas e insumos'])
wr.append(['Marco del plan'])
wr.append(['SEMANA TIPO'])
wr.append(['DÍA', 'FOCO PRIORITARIO', 'RUTINA FIJA'])
for day, focus, routine in [('Lunes', 'Operaciones y permisos.', '09:00 · planificación con Beatriz'), ('Martes', 'Bodega e inventario.', 'Recorrido'), ('Miércoles', 'Clientes y propuestas.', 'Actualizar cartera'),
                            ('Jueves', 'Proveedores.', 'Revisión con Carlos'), ('Viernes (remoto)', 'Reportes.', 'Reporte antes de las 14:00'), ('Sábado', 'Descanso.', ''), ('Domingo', 'Descanso.', '')]:
    wr.append([day, focus, routine])
wr.append(['LÍMITES Y REGLAS'])
wr.append(['Precios', 'Solo precios aprobados por la jefatura.'])
wr.append(['Escalamiento', 'Todo atraso se informa el mismo día.'])
wr.append(['INSUMOS PARA EL DÍA 1'])
wr.append(['Acceso', 'Credencial y elementos de protección.'])
wb.save(out)
print(out)
