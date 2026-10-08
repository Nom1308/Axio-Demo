/* Axio demo: «¿Sabías que…?» durante la primera carga.
 *
 * Debajo del buscador, con la barra de avance real arriba, va una pregunta de cultura
 * general con cuatro opciones. Al responder se cuenta el dato completo, se acierte o no.
 * Cuando la carga termina (evento axio-carga-fin de puente.js) se despide con el resumen,
 * el panel se recoge y el buscador queda listo.
 *
 * Solo guarda en este navegador cuánto tardó la última carga (para estimar la barra) y qué
 * preguntas ya salieron (para no repetirlas pronto). Nada de datos de las hojas.
 */
(function () {
  "use strict";

  // Datos verificables y sin polémica: es una aplicación institucional.
  const PREGUNTAS = [
    { p: "¿Cuántos corazones tiene un pulpo?", o: ["1", "2", "3", "4"], r: 2,
      d: "Tiene 3: dos bombean la sangre hacia las branquias y el tercero al resto del cuerpo. Además, su sangre es azul." },
    { p: "¿Qué país tiene más especies de aves en el mundo?", o: ["Brasil", "Colombia", "Perú", "Indonesia"], r: 1,
      d: "Colombia, con más de 1.900 especies registradas: casi una de cada cinco especies de aves del planeta." },
    { p: "¿Cuál es el único mamífero capaz de volar?", o: ["La ardilla voladora", "El murciélago", "El colugo", "El petauro"], r: 1,
      d: "El murciélago. La ardilla voladora y el colugo solo planean; el murciélago aletea y vuela de verdad." },
    { p: "¿Cuántos huesos tiene el cuerpo de una persona adulta?", o: ["156", "206", "256", "306"], r: 1,
      d: "206. Al nacer tenemos cerca de 300, pero muchos se van uniendo mientras crecemos." },
    { p: "¿En qué planeta un día dura más que un año?", o: ["Mercurio", "Marte", "Venus", "Júpiter"], r: 2,
      d: "En Venus: gira tan despacio que una vuelta sobre sí mismo (243 días terrestres) tarda más que una vuelta al Sol (225)." },
    { p: "¿Cuántas teclas tiene un piano estándar?", o: ["66", "76", "88", "96"], r: 2,
      d: "88: 52 blancas y 36 negras." },
    { p: "¿Qué animal tiene huellas dactilares casi iguales a las humanas?", o: ["El chimpancé", "El koala", "El gorila", "El mapache"], r: 1,
      d: "El koala. Sus huellas se parecen tanto a las nuestras que hasta con microscopio cuesta distinguirlas." },
    { p: "¿Qué alimento puede durar miles de años sin dañarse?", o: ["El arroz", "La sal marina", "La miel", "El azúcar morena"], r: 2,
      d: "La miel. En tumbas del antiguo Egipto se han encontrado vasijas con miel de miles de años, todavía comestible." },
    { p: "¿Cuánto tarda la luz del Sol en llegar a la Tierra?", o: ["8 segundos", "Unos 8 minutos", "Unas 8 horas", "Es instantánea"], r: 1,
      d: "Unos 8 minutos y 20 segundos. El Sol que vemos es el de hace 8 minutos." },
    { p: "¿Cuál es el hueso más largo del cuerpo humano?", o: ["La tibia", "El húmero", "El fémur", "El peroné"], r: 2,
      d: "El fémur, el hueso del muslo. También es uno de los más fuertes." },
    { p: "¿Cuál es la flor nacional de Colombia?", o: ["La rosa", "La orquídea Cattleya trianae", "El girasol", "La heliconia"], r: 1,
      d: "La orquídea Cattleya trianae, también llamada flor de mayo. Colombia es uno de los países con más especies de orquídeas." },
    { p: "¿Cuál es el ave nacional de Colombia?", o: ["El colibrí", "El cóndor de los Andes", "La guacamaya", "El águila arpía"], r: 1,
      d: "El cóndor de los Andes, que aparece en el escudo nacional. Con las alas abiertas puede superar los 3 metros." },
    { p: "¿Cuántos departamentos tiene Colombia?", o: ["28", "30", "32", "34"], r: 2,
      d: "32 departamentos, más Bogotá como Distrito Capital." },
    { p: "¿Qué ciudad colombiana es conocida como «la ciudad de la eterna primavera»?", o: ["Cali", "Medellín", "Bucaramanga", "Pereira"], r: 1,
      d: "Medellín, por su clima templado durante todo el año." },
    { p: "¿Por qué Caño Cristales, en el Meta, es llamado «el río de los cinco colores»?", o: ["Por minerales en el agua", "Por una planta acuática", "Por la luz del atardecer", "Por peces de colores"], r: 1,
      d: "Por una planta acuática, la Macarenia clavigera, que se pone roja y rosada en ciertos meses del año." },
    { p: "¿Dónde nació la primera cooperativa moderna?", o: ["En Rochdale, Inglaterra", "En París, Francia", "En Boston, Estados Unidos", "En Berlín, Alemania"], r: 0,
      d: "En Rochdale, Inglaterra, en 1844: 28 trabajadores fundaron la Sociedad de los Justos Pioneros. Sus principios todavía guían a las cooperativas." },
    { p: "Si los intereses de un ahorro se suman al capital y también empiezan a generar intereses, eso se llama…", o: ["Interés simple", "Interés compuesto", "Interés de mora", "Tasa fija"], r: 1,
      d: "Interés compuesto: los intereses ganan intereses. Por eso ahorrar desde temprano rinde tanto." },
    { p: "¿Por qué existe el año bisiesto?", o: ["Por la Luna", "Porque la Tierra tarda unos 365 días y 6 horas en dar la vuelta al Sol", "Por una ley romana sin razón astronómica", "Por los cambios de estación"], r: 1,
      d: "Esas 6 horas de más suman un día cada 4 años; se agrega el 29 de febrero para que el calendario no se desfase." },
    { p: "¿Cuántas veces late el corazón humano en un día, aproximadamente?", o: ["10.000", "50.000", "100.000", "1.000.000"], r: 2,
      d: "Unas 100.000 veces al día: más de 35 millones de latidos al año." },
    { p: "¿Qué metal es líquido a temperatura ambiente?", o: ["El estaño", "El mercurio", "El plomo", "El aluminio"], r: 1,
      d: "El mercurio. Por eso se usaba en los termómetros antiguos." },
    { p: "¿Cuál es el desierto más grande del mundo?", o: ["El Sahara", "El de Gobi", "La Antártida", "El de Atacama"], r: 2,
      d: "La Antártida. Un desierto es un lugar donde casi no llueve ni nieva, y ahí cae muy poca precipitación. El Sahara es el desierto cálido más grande." },
    { p: "¿Qué ave puede volar hacia atrás?", o: ["La golondrina", "El colibrí", "El halcón", "La paloma"], r: 1,
      d: "El colibrí: puede quedarse quieto en el aire y volar hacia atrás, batiendo las alas decenas de veces por segundo." },
    { p: "¿Cuántos ojos tiene una abeja?", o: ["2", "3", "5", "8"], r: 2,
      d: "5: dos grandes a los lados de la cabeza y tres pequeños arriba, que le ayudan a orientarse con la luz." },
    { p: "¿Qué escritor colombiano ganó el Premio Nobel de Literatura?", o: ["Álvaro Mutis", "Gabriel García Márquez", "Jorge Isaacs", "Fernando Vallejo"], r: 1,
      d: "Gabriel García Márquez, en 1982. «Cien años de soledad» se ha traducido a decenas de idiomas." },
    { p: "¿Qué tipo de café cultiva principalmente Colombia?", o: ["Robusta", "Arábica", "Liberica", "Excelsa"], r: 1,
      d: "Arábica, de sabor suave. Se cultiva en las laderas de las montañas, muchas veces a mano y en fincas familiares." },
    { p: "¿Cuál es el río más caudaloso del mundo?", o: ["El Nilo", "El Amazonas", "El Misisipi", "El Yangtsé"], r: 1,
      d: "El Amazonas: aporta cerca de la quinta parte de toda el agua dulce que los ríos del mundo llevan al mar. Parte de su cuenca está en Colombia." },
    { p: "¿Cuál es el segundo idioma con más hablantes nativos en el mundo?", o: ["El inglés", "El español", "El hindi", "El árabe"], r: 1,
      d: "El español, con cerca de 500 millones de hablantes nativos. Solo lo supera el chino mandarín." },
    { p: "¿Cuál es el océano más grande del planeta?", o: ["El Atlántico", "El Índico", "El Pacífico", "El Ártico"], r: 2,
      d: "El Pacífico: cubre cerca de un tercio de la superficie de la Tierra, más que todos los continentes juntos." },
  ];
  const LETRAS = ["A", "B", "C", "D"];

  const $ = (sel) => document.querySelector(sel);
  const leer = (clave, porDefecto) => { try { return localStorage.getItem(clave) ?? porDefecto; } catch (_) { return porDefecto; } };
  const guardar = (clave, valor) => { try { localStorage.setItem(clave, String(valor)); } catch (_) { /* sin almacenamiento */ } };

  let panel = null;
  let inicioCarga = 0;
  let cuadroBarra = 0;
  let pisoBarra = 0;
  let duracionEsperada = Math.max(15, Number(leer("axio-duracion-carga", 45)) || 45);   // segundos
  let orden = [];
  let actual = -1;
  let respondidas = 0, aciertos = 0;
  let siguienteAuto = 0;

  function nodo(etiqueta, props, ...hijos) {
    const n = document.createElement(etiqueta);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const h of hijos) if (h) n.append(h);
    return n;
  }

  // Las que no salieron hace poco van primero; dentro de cada grupo, al azar.
  function prepararOrden() {
    let vistas = [];
    try { vistas = JSON.parse(leer("axio-preguntas-vistas", "[]")); } catch (_) { vistas = []; }
    const azar = (lista) => lista.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const indices = PREGUNTAS.map((_, i) => i);
    orden = [...azar(indices.filter((i) => !vistas.includes(i))), ...azar(indices.filter((i) => vistas.includes(i)))];
  }
  function anotarVista(i) {
    let vistas = [];
    try { vistas = JSON.parse(leer("axio-preguntas-vistas", "[]")); } catch (_) { vistas = []; }
    vistas = [...vistas.filter((x) => x !== i), i].slice(-Math.floor(PREGUNTAS.length * 0.7));
    guardar("axio-preguntas-vistas", JSON.stringify(vistas));
  }

  // ------------------------------------------------------------------ panel y barra
  function abrir() {
    if (panel) return;
    inicioCarga = performance.now();
    pisoBarra = 0;
    respondidas = aciertos = 0;
    actual = -1;
    prepararOrden();
    panel = nodo("section", { class: "espera", "aria-label": "Cargando Axio", "aria-live": "polite" },
      nodo("div", { class: "espera-cabecera" },
        nodo("span", { class: "espera-mensaje", text: "⏳ Preparando Axio…" }),
        nodo("span", { class: "espera-porcentaje", text: "0 %" })),
      nodo("div", { class: "espera-barra" }, nodo("span", { class: "espera-relleno" })),
      nodo("div", { class: "espera-cuerpo" }));
    const zona = $("#asociado-zona");
    zona.parentNode.insertBefore(panel, zona);
    siguiente();
    cuadroBarra = requestAnimationFrame(avanzarBarra);
  }

  // La barra estima con lo que tardó la última carga; los avisos de descarga ("3 de 9") la
  // empujan. No llega a 100 % hasta que de verdad termina.
  function avanzarBarra() {
    if (!panel) return;
    const t = (performance.now() - inicioCarga) / 1000;
    ponerAvance(Math.max(pisoBarra, Math.min(0.96, 1 - Math.exp(-2.2 * t / duracionEsperada))));
    cuadroBarra = requestAnimationFrame(avanzarBarra);
  }
  function ponerAvance(f) {
    if (!panel) return;
    panel.querySelector(".espera-relleno").style.width = (f * 100).toFixed(1) + "%";
    panel.querySelector(".espera-porcentaje").textContent = Math.floor(f * 100) + " %";
  }

  window.addEventListener("axio-progreso", (ev) => {
    if (!panel) return;
    const texto = ev.detail.mensaje || "";
    panel.querySelector(".espera-mensaje").textContent = "⏳ " + texto;
    const m = /(\d+) de (\d+)/.exec(texto);
    if (m && /Descargando/.test(texto)) pisoBarra = Math.max(pisoBarra, 0.1 + 0.3 * Number(m[1]) / Number(m[2]));
    if (/Leyendo|descargadas/.test(texto)) pisoBarra = Math.max(pisoBarra, 0.45);
  });

  // ------------------------------------------------------------------ preguntas
  function siguiente() {
    clearTimeout(siguienteAuto);
    if (!panel) return;
    actual = (actual + 1) % orden.length;
    const i = orden[actual];
    const q = PREGUNTAS[i];
    anotarVista(i);
    const opciones = nodo("div", { class: "espera-opciones" });
    q.o.forEach((texto, k) => opciones.append(nodo("button", { class: "espera-opcion", type: "button", onclick: () => responder(q, k, opciones) },
      nodo("span", { class: "espera-letra", text: LETRAS[k] }), nodo("span", { text: texto }))));
    const tarjeta = nodo("div", { class: "espera-tarjeta" },
      nodo("div", { class: "espera-etiqueta" },
        nodo("span", { text: "💡 ¿Sabías que…?" }),
        respondidas ? nodo("span", { class: "espera-marcador", text: `${aciertos} de ${respondidas} correctas` }) : null),
      nodo("p", { class: "espera-pregunta", text: q.p }),
      opciones,
      nodo("div", { class: "espera-respuesta", hidden: true }));
    panel.querySelector(".espera-cuerpo").replaceChildren(tarjeta);
  }

  function responder(q, elegida, opciones) {
    if (opciones.dataset.respondida) return;
    opciones.dataset.respondida = "1";
    const bien = elegida === q.r;
    respondidas++;
    if (bien) aciertos++;
    [...opciones.children].forEach((b, k) => {
      b.disabled = true;
      if (k === q.r) b.classList.add("correcta");
      else if (k === elegida) b.classList.add("incorrecta");
    });
    const caja = panel.querySelector(".espera-respuesta");
    caja.hidden = false;
    caja.className = "espera-respuesta " + (bien ? "bien" : "casi");
    caja.replaceChildren(
      nodo("strong", { text: bien ? "🎉 ¡Muy bien!" : `😅 ¡Uy, casi! Era «${q.o[q.r]}».` }),
      nodo("p", { text: q.d }),
      nodo("button", { class: "boton boton-chico espera-siguiente", type: "button", text: "Otra pregunta →", onclick: siguiente }));
    const marcador = panel.querySelector(".espera-marcador");
    if (marcador) marcador.textContent = `${aciertos} de ${respondidas} correctas`;
    else panel.querySelector(".espera-etiqueta").append(nodo("span", { class: "espera-marcador", text: `${aciertos} de ${respondidas} correctas` }));
    // Si no pasa a la siguiente, pasa sola cuando alcanzó a leer el dato.
    siguienteAuto = setTimeout(siguiente, 9000 + q.d.length * 30);
  }

  // ------------------------------------------------------------------ despedida
  function terminar(error) {
    if (!panel) return;
    cancelAnimationFrame(cuadroBarra);
    clearTimeout(siguienteAuto);
    guardar("axio-duracion-carga", Math.round((performance.now() - inicioCarga) / 1000));
    ponerAvance(1);
    panel.querySelector(".espera-mensaje").textContent = error ? "⚠️ Terminó con avisos: revisa las fuentes" : "✓ Datos cargados";
    const resultado = respondidas
      ? `Acertaste ${aciertos} de ${respondidas}${aciertos === respondidas ? " 🏆" : ""}.` : "";
    panel.querySelector(".espera-cuerpo").replaceChildren(nodo("div", { class: "espera-tarjeta espera-final" },
      nodo("strong", { text: error ? "Axio cargó, con algunos avisos" : "✨ ¡Axio está listo!" }),
      nodo("p", { text: [resultado, "¡Suerte en tus búsquedas, nos vemos pronto! 👋"].filter(Boolean).join(" ") })));
    const p = panel;
    panel = null;
    setTimeout(() => {
      p.style.height = p.offsetHeight + "px";
      requestAnimationFrame(() => p.classList.add("espera-cerrando"));
      setTimeout(() => p.remove(), 650);
      const caja = $("#form-busqueda");
      if (caja) { caja.classList.add("axio-listo"); setTimeout(() => caja.classList.remove("axio-listo"), 1600); }
      const q = $("#q");
      if (q && !document.querySelector("dialog[open]") && !document.activeElement.closest("input, textarea, select")) q.focus({ preventScroll: true });
    }, 3200);
  }

  // Solo en la primera carga (al entrar); «Refrescar datos» no lo muestra.
  window.addEventListener("axio-carga-inicio", (ev) => { if (ev.detail.accion === "configurar") abrir(); });
  window.addEventListener("axio-carga-fin", (ev) => { if (ev.detail.accion === "configurar") terminar(ev.detail.error); });
})();
