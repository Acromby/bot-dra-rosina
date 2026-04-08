# Bot WhatsApp - Consultorio de la Dra. Rosina

Bot de WhatsApp con IA para agendar citas de medicina estética.

## Variables de entorno requeridas en Railway

| Variable | Descripción |
|---|---|
| `WHATSAPP_TOKEN` | Token de acceso de Meta Developers |
| `PHONE_NUMBER_ID` | ID del número de teléfono de WhatsApp |
| `VERIFY_TOKEN` | Token para verificar webhook (usa: dra-rosina-2024) |
| `ANTHROPIC_API_KEY` | API key de Anthropic |
| `NODE_ENV` | `development` para pruebas, `production` para real |

## Tiempos de recordatorio

- **development**: recordatorio en 1 min, retoque en 5 min
- **production**: recordatorio en 1 hora, retoque en 5 meses

## Webhook URL

Una vez desplegado en Railway, la URL del webhook es:
`https://TU-PROYECTO.railway.app/webhook`
