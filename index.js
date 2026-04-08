const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN || 'dra-rosina-2024';
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const CALENDAR_ID     = process.env.GOOGLE_CALENDAR_ID;
const PORT            = process.env.PORT || 3000;

const GOOGLE_CREDS = {
  type: 'service_account',
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  token_uri: 'https://oauth2.googleapis.com/token',
};

const clientes = {};

const SERVICIOS = [
  'Botox / Toxina botulínica',
  'Rellenos de ácido hialurónico',
  'Limpieza facial',
  'Tratamientos láser',
  'Mesoterapia'
];

const PRODUCTOS_RELACIONADOS = {
  'Botox / Toxina botulínica':      ['Rellenos de ácido hialurónico', 'Mesoterapia'],
  'Rellenos de ácido hialurónico':  ['Botox / Toxina botulínica', 'Tratamientos láser'],
  'Limpieza facial':                ['Mesoterapia', 'Tratamientos láser'],
  'Tratamientos láser':             ['Limpieza facial', 'Mesoterapia'],
  'Mesoterapia':                    ['Botox / Toxina botulínica', 'Limpieza facial']
};

const SYSTEM_PROMPT = `Eres Bon, el ayudante personal de Mely (la Dra. Rosina), especialista en medicina estética.
Responde SIEMPRE en español de México, con tono cálido, cercano y amigable. Sé conciso (máx 3 oraciones por mensaje).
Usa emojis con moderación. Nunca digas que eres un bot, asistente virtual o IA.
Cuando el cliente ya tiene historial, úsalo de forma natural.
Siempre llama al cliente por su nombre cuando lo sepas.`;

// ─── GOOGLE CALENDAR ──────────────────────────────────────────────
async function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDS,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

async function getAvailableSlots(fechaStr) {
  const SLOTS_BASE = {
    1: ['10:00','11:00','13:00','16:00'],
    2: ['09:00','11:30','15:00','17:00'],
    3: ['10:00','12:00','14:30'],
    4: ['09:30','11:00','16:00','17:30'],
    5: ['10:00','13:00','15:00'],
  };
  try {
    const calendar = await getCalendarClient();
    const start = new Date(fechaStr + 'T00:00:00');
    const end   = new Date(fechaStr + 'T23:59:59');
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
    });
    const ocupados = (res.data.items || []).map(e => {
      const d = new Date(e.start.dateTime || e.start.date);
      return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    });
    const diaSemana = new Date(fechaStr + 'T12:00:00').getDay();
    return (SLOTS_BASE[diaSemana] || []).filter(s => !ocupados.includes(s));
  } catch (e) {
    console.error('Error slots:', e.message);
    const diaSemana = new Date(fechaStr + 'T12:00:00').getDay();
    return SLOTS_BASE[diaSemana] || [];
  }
}

async function crearEvento(cliente) {
  try {
    const calendar = await getCalendarClient();
    const [y,m,d] = cliente.fechaSeleccionada.split('-').map(Number);
    const [h,min] = cliente.horaSeleccionada.split(':').map(Number);
    const inicio = new Date(y, m-1, d, h, min);
    const fin    = new Date(inicio.getTime() + 60*60*1000);
    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: {
        summary: `${cliente.nombre} — ${cliente.servicioActual}`,
        description: `WhatsApp: ${cliente.phone}`,
        start: { dateTime: inicio.toISOString(), timeZone: 'America/Mexico_City' },
        end:   { dateTime: fin.toISOString(),   timeZone: 'America/Mexico_City' },
      },
    });
    console.log(`📅 Evento creado: ${cliente.nombre} ${cliente.fechaSeleccionada} ${cliente.horaSeleccionada}`);
  } catch (e) {
    console.error('Error creando evento:', e.message);
  }
}

// ─── WHATSAPP ────────────────────────────────────────────────────
async function sendText(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product:'whatsapp', to, type:'text', text:{ body: text } },
      { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' } }
    );
  } catch (e) {
    console.error('Error sendText:', e.response?.data || e.message);
  }
}

async function sendInteractive(to, bodyText, opciones) {
  try {
    if (opciones.length <= 3) {
      await axios.post(
        `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp', to, type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: bodyText },
            action: {
              buttons: opciones.map((o,i) => ({
                type: 'reply',
                reply: { id: `opt_${i}`, title: String(o).slice(0,20) }
              }))
            }
          }
        },
        { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' } }
      );
    } else {
      await axios.post(
        `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp', to, type: 'interactive',
          interactive: {
            type: 'list',
            body: { text: bodyText },
            action: {
              button: 'Ver opciones',
              sections: [{ title: 'Elige una opción', rows: opciones.map((o,i) => ({ id:`opt_${i}`, title: String(o).slice(0,24) })) }]
            }
          }
        },
        { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' } }
      );
    }
  } catch (e) {
    console.error('Error interactive, enviando texto:', e.response?.data?.error?.message || e.message);
    await sendText(to, bodyText + '\n\n' + opciones.map((o,i) => `${i+1}. ${o}`).join('\n'));
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────
function getDiasDisponibles(mes, anio) {
  const NOMBRES_DIA = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const dias = [];
  const fecha = new Date(anio, mes-1, 1);
  while (fecha.getMonth() === mes-1) {
    const dow = fecha.getDay();
    if ([1,2,3,4,5].includes(dow) && fecha > hoy) {
      const dd = fecha.getDate();
      dias.push({
        label: `${NOMBRES_DIA[dow]} ${dd}`,
        fecha: `${anio}-${String(mes).padStart(2,'0')}-${String(dd).padStart(2,'0')}`,
      });
    }
    fecha.setDate(fecha.getDate()+1);
  }
  return dias;
}

function formatFecha(fechaStr, hora) {
  const [y,m,d] = fechaStr.split('-').map(Number);
  const f = new Date(y, m-1, d);
  const DIAS  = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const h = parseInt(hora); const ampm = h>=12?'PM':'AM'; const h12 = h>12?h-12:h===0?12:h;
  return `${DIAS[f.getDay()]} ${d} de ${MESES[m-1]} de ${y} a las ${h12}:${hora.split(':')[1]} ${ampm}`;
}

function detectarServicio(texto) {
  const t = texto.toLowerCase();
  if (t.includes('botox')||t.includes('toxina')) return SERVICIOS[0];
  if (t.includes('relleno')||t.includes('hialur')) return SERVICIOS[1];
  if (t.includes('limpieza')) return SERVICIOS[2];
  if (t.includes('láser')||t.includes('laser')) return SERVICIOS[3];
  if (t.includes('mesoterapia')) return SERVICIOS[4];
  return null;
}

// ─── FLUJO PRINCIPAL ──────────────────────────────────────────────
const E = { INICIO:'inicio', NOMBRE:'nombre', SERVICIO:'servicio', MES:'mes', DIA:'dia', HORA:'hora', CONFIRMAR:'confirmar', LIBRE:'libre' };

async function manejarMensaje(phone, texto) {
  if (!clientes[phone]) {
    clientes[phone] = { phone, nombre:null, estado:E.INICIO, servicioActual:null, ultimoServicio:null, historialCitas:[], _dias:[], mesNum:null, anioNum:null, fechaSeleccionada:null, horaSeleccionada:null, diaLabel:null, recordatorioSet:false, retoqueSet:false };
  }
  const c = clientes[phone];
  const t = (texto||'').toLowerCase().trim();
  console.log(`📨 [${phone}] (${c.estado}): ${texto}`);

  // INICIO
  if (c.estado === E.INICIO) {
    if (c.nombre) {
      c.estado = E.SERVICIO;
      await sendInteractive(phone, `¡Hola ${c.nombre}! 😊 ¿Qué te gustaría hacer hoy?`, ['Agendar cita','Ver servicios']);
    } else {
      c.estado = E.NOMBRE;
      await sendText(phone, `¡Hola! 😊 Soy Bon. Para empezar, ¿me dices tu nombre completo?`);
    }
    return;
  }

  // NOMBRE
  if (c.estado === E.NOMBRE) {
    const m = texto.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,})\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,})\b/);
    if (m) {
      c.nombre = m[1]+' '+m[2];
      c.estado = E.SERVICIO;
      await sendText(phone, `¡Mucho gusto, ${c.nombre}! 🌸 Estos son los servicios que tenemos:`);
      await sendInteractive(phone, '¿Cuál te interesa?', SERVICIOS.slice(0,3));
      await sendInteractive(phone, 'También tenemos:', SERVICIOS.slice(3));
    } else {
      await sendText(phone, `Necesito tu nombre y apellido completos. ¿Me los dices? 😊`);
    }
    return;
  }

  // SERVICIO
  if (c.estado === E.SERVICIO) {
    if (t.includes('ver servicios') || t.includes('servicios')) {
      await sendInteractive(phone, '¿Cuál te interesa?', SERVICIOS.slice(0,3));
      await sendInteractive(phone, 'También tenemos:', SERVICIOS.slice(3));
      return;
    }
    if (t.includes('agendar') || t.includes('cita')) {
      await sendInteractive(phone, '¿Qué servicio quieres agendar?', SERVICIOS.slice(0,3));
      await sendInteractive(phone, 'También tenemos:', SERVICIOS.slice(3));
      return;
    }
    const srv = detectarServicio(texto);
    if (srv) {
      c.servicioActual = srv;
      c.estado = E.MES;
      const hoy = new Date();
      const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
      const opcMes = [0,1,2].map(i => {
        const d = new Date(hoy.getFullYear(), hoy.getMonth()+i, 1);
        return `${MESES_ES[d.getMonth()]} ${d.getFullYear()}`;
      });
      await sendInteractive(phone, `Perfecto, *${srv}* 💉\n¿En qué mes quieres tu cita?`, opcMes);
    } else {
      await sendInteractive(phone, `¿Cuál servicio te interesa, ${c.nombre}?`, SERVICIOS.slice(0,3));
      await sendInteractive(phone, 'También tenemos:', SERVICIOS.slice(3));
    }
    return;
  }

  // MES
  if (c.estado === E.MES) {
    const MESES_MAP = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };
    let mesNum=null, anioNum=new Date().getFullYear();
    Object.entries(MESES_MAP).forEach(([n,v]) => { if(t.includes(n)) mesNum=v; });
    const am = t.match(/\d{4}/); if(am) anioNum=parseInt(am[0]);
    if (mesNum) {
      c.mesNum=mesNum; c.anioNum=anioNum;
      const dias = getDiasDisponibles(mesNum, anioNum).slice(0,9);
      c._dias = dias;
      if (!dias.length) { await sendText(phone, 'No hay días disponibles ese mes. ¿Pruebas con otro? 📅'); return; }
      c.estado = E.DIA;
      await sendInteractive(phone, `¿Qué día te queda mejor?`, dias.slice(0,3).map(d=>d.label));
      if (dias.length>3) await sendInteractive(phone, 'O también:', dias.slice(3,6).map(d=>d.label));
      if (dias.length>6) await sendInteractive(phone, 'O también:', dias.slice(6,9).map(d=>d.label));
    } else {
      await sendText(phone, `¿En qué mes? Dime por ejemplo: Abril, Mayo... 📅`);
    }
    return;
  }

  // DIA
  if (c.estado === E.DIA) {
    let diaObj = c._dias.find(d => t.includes(d.label.toLowerCase()));
    if (!diaObj) {
      const nm = t.match(/\b(\d{1,2})\b/);
      if (nm) diaObj = c._dias.find(d => parseInt(d.label.split(' ')[1]) === parseInt(nm[1]));
    }
    if (diaObj) {
      c.diaLabel = diaObj.label; c.fechaSeleccionada = diaObj.fecha;
      const slots = await getAvailableSlots(diaObj.fecha);
      if (!slots.length) { await sendText(phone, `Ese día ya no tiene horarios libres. ¿Pruebas con otro? 😅`); return; }
      c.estado = E.HORA;
      await sendInteractive(phone, `¿A qué hora el ${diaObj.label}?`, slots.slice(0,3));
      if (slots.length>3) await sendInteractive(phone, 'O también:', slots.slice(3,6));
    } else {
      await sendText(phone, `No encontré ese día. ¿Me dices el número? (ej: 14) 📅`);
    }
    return;
  }

  // HORA
  if (c.estado === E.HORA) {
    const hm = texto.match(/\b(\d{1,2}:\d{2})\b/);
    if (hm) {
      c.horaSeleccionada = hm[1];
      c.estado = E.CONFIRMAR;
      const fechaFmt = formatFecha(c.fechaSeleccionada, c.horaSeleccionada);
      await sendInteractive(phone,
        `Todo listo, ${c.nombre}. Confirma tu cita:\n\n💉 *${c.servicioActual}*\n📅 ${fechaFmt}\n\n¿Todo correcto?`,
        ['✅ Confirmar','❌ Cambiar']
      );
    } else {
      await sendText(phone, `¿A qué hora? Escríbela así: 10:00 o 13:00 ⏰`);
    }
    return;
  }

  // CONFIRMAR
  if (c.estado === E.CONFIRMAR) {
    if (t.includes('confirm')||t.includes('sí')||t.includes('si')||t.includes('✅')||t.includes('ok')||t.includes('dale')) {
      const fechaFmt = formatFecha(c.fechaSeleccionada, c.horaSeleccionada);
      c.historialCitas.push({ servicio:c.servicioActual, fecha:c.fechaSeleccionada, hora:c.horaSeleccionada, fechaFmt });
      c.ultimoServicio = c.servicioActual;
      await crearEvento(c);
      await sendText(phone, `✅ ¡Cita confirmada, ${c.nombre}!\n\n💉 ${c.servicioActual}\n📅 ${fechaFmt}\n\nTe mando un recordatorio 1 hora antes. ¡Hasta entonces! 💐`);
      programarRecordatorios(phone);
      c.estado = E.LIBRE;
    } else if (t.includes('cambi')||t.includes('no')||t.includes('❌')) {
      c.estado = E.SERVICIO;
      c.servicioActual = null; c.fechaSeleccionada = null; c.horaSeleccionada = null;
      await sendInteractive(phone, `Sin problema. ¿Qué cambiamos?`, ['Servicio','Fecha y hora']);
    }
    return;
  }

  // LIBRE - conversación general
  if (c.estado === E.LIBRE) {
    if (t.includes('cita')||t.includes('agendar')||t.includes('reservar')) {
      c.estado = E.SERVICIO; c.servicioActual = null;
      await sendInteractive(phone, `¡Claro, ${c.nombre}! ¿Qué servicio esta vez?`, SERVICIOS.slice(0,3));
      await sendInteractive(phone, 'También tenemos:', SERVICIOS.slice(3));
      return;
    }
    // IA para preguntas libres
    try {
      const histCtx = c.historialCitas.length > 0
        ? `Última cita: ${c.ultimoServicio} el ${c.historialCitas[c.historialCitas.length-1].fechaFmt}.`
        : 'Sin citas previas.';
      const resp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model:'claude-haiku-4-5-20251001', max_tokens:200, system: SYSTEM_PROMPT+`\nCliente: ${c.nombre}. ${histCtx}`, messages:[{ role:'user', content:texto }] },
        { headers:{ 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'Content-Type':'application/json' } }
      );
      await sendText(phone, resp.data.content.map(b=>b.text||'').join(''));
    } catch(e) {
      await sendText(phone, `¡Hola ${c.nombre}! ¿Quieres agendar una cita o tienes alguna pregunta? 😊`);
    }
    return;
  }

  // Fallback
  c.estado = E.INICIO;
  await manejarMensaje(phone, texto);
}

// ─── RECORDATORIOS ────────────────────────────────────────────────
function programarRecordatorios(phone) {
  const c = clientes[phone];
  if (!c || c.recordatorioSet) return;
  c.recordatorioSet = true;

  const prueba = process.env.NODE_ENV !== 'production';
  const msRec = prueba ? 60*1000 : 60*60*1000;
  const msRet = prueba ? 5*60*1000 : 5*30*24*60*60*1000;

  setTimeout(async () => {
    const ult = c.historialCitas[c.historialCitas.length-1];
    await sendText(phone, `⏰ Recordatorio: ¡Hola ${c.nombre}! Tu cita es en 1 hora:\n💉 ${ult?.servicio}\n📅 ${ult?.fechaFmt}\n\n¡Nos vemos pronto! 💐`);
  }, msRec);

  setTimeout(async () => {
    if (c.retoqueSet) return;
    c.retoqueSet = true;
    const rel = (PRODUCTOS_RELACIONADOS[c.ultimoServicio]||[]).map(s=>`• ${s}`).join('\n');
    await sendText(phone,
      `¡Hola ${c.nombre}! 💕\n\nHan pasado 5 meses desde tu ${c.ultimoServicio} con Mely. ¡Ya es tiempo de tu retoque! 💉\n\n` +
      `También tenemos cosas nuevas que te pueden interesar:\n${rel}\n\n¿Te agendo? 😊`
    );
    c.estado = E.SERVICIO;
  }, msRet);
}

// ─── WEBHOOK ─────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode']==='subscribe' && req.query['hub.verify_token']===VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;
    const phone = msg.from;
    let texto = null;
    if (msg.type === 'text') {
      texto = msg.text?.body;
    } else if (msg.type === 'interactive') {
      texto = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
    }
    if (!texto) return;
    console.log(`📨 ${phone}: ${texto}`);
    await manejarMensaje(phone, texto);
  } catch (e) {
    console.error('Error webhook:', e.message);
  }
});

app.get('/', (req, res) => res.json({ status:'ok', bot:'Bon — Consultorio Dra. Rosina', clientes: Object.keys(clientes).length }));

app.listen(PORT, () => console.log(`🐾 Bon corriendo en puerto ${PORT}`));
