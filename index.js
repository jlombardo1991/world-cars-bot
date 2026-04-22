require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
const nodemailer = require("nodemailer");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use("/audio", express.static("public"));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 🌍 Mapear idioma
function getTwilioLang(lang) {
  switch (lang) {
    case "es": return "es-ES";
    case "pt": return "pt-BR";
    case "zh": return "zh-CN";
    case "en": return "en-US";
    default: return "en-US";
  }
}

// Prompt
const systemPrompt = `
You are a friendly and natural car service receptionist for WORLD CARS.

- Speak like a human, warm & helpful.
- Use short, clear sentences

SERVICES OFFERED:
- Standard Service: oil change, oil filter, basic inspection
- Full Service: Customer can check website
- Diagnostics: engine lights or mechanical issues 
- Repairs: brakes, suspension, engine work
- Tyres replacement & balance (ask tyre size and quantity)

RULES:
- Do NOT invent prices
- Guide the customer
- Booking hours: Monday to Friday 7:30 AM to 5 PM
- Closed on New Zealand public holidays

LANGUAGE:
- Detect user language and reply in same language
- Supported: English, Spanish, Portuguese, Chinese (Mandarin)
- Do NOT mention language switching

IMPORTANT:
- Do NOT ask same info twice
- Extract multiple data if given

BOOKING:
1. Name + phone
2. Vehicle + plate
3. Service
4. Date/time

Use [END_OF_BOOKING] internally only.
`;

const conversations = {};

// 🔊 Audio
async function generarAudio(texto, fileName) {
  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: texto,
    speed: 1.2,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(path.join(__dirname, "public", `${fileName}.mp3`), buffer);
}

// 📧 Email
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 🧠 Resumen
async function generarResumen(conversation) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [{
      role: "user",
      content: `
Extract booking info as JSON:
fullName, phone, vehicle, licensePlate, serviceType, dateTime

${conversation.map(m => `${m.role}: ${m.content}`).join("\n")}
`
    }]
  });

  return JSON.parse(completion.choices[0].message.content);
}

// 📧 Enviar email
async function enviarEmail(conversation) {
  const s = await generarResumen(conversation);

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: "info@worldcars.co.nz",
    subject: `Booking: ${s.licensePlate || "??"} | ${s.serviceType || "??"} | ${s.dateTime || "??"}`,
    html: `
<p><b>Name:</b> ${s.fullName}</p>
<p><b>Phone:</b> ${s.phone}</p>
<p><b>Vehicle:</b> ${s.vehicle}</p>
<p><b>Plate:</b> ${s.licensePlate}</p>
<p><b>Service:</b> ${s.serviceType}</p>
<p><b>Date:</b> ${s.dateTime}</p>
`
  });

  console.log("📧 Email enviado");
}

// 📞 Ruta
app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult?.trim();

  if (!conversations[callSid]) {
    conversations[callSid] = [{ role: "system", content: systemPrompt }];
  }

  const conversation = conversations[callSid];
  let ttsText = "";
  let finished = false;

  // 🧠 SIN INPUT
  if (!speech) {
    ttsText =
      "Hello, thank you for calling World Cars. I can help you book your vehicle. Please tell me your full name and phone number.";

  } else {
    conversation.push({ role: "user", content: speech });

    // 🌍 Detectar idioma UNA VEZ
    if (!conversations[callSid].lang) {
      try {
        const langDetect = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{
            role: "user",
            content: `Detect language (en, es, pt, zh only): ${speech}`
          }]
        });

        conversations[callSid].lang =
          langDetect.choices[0].message.content.trim().toLowerCase();

      } catch {
        conversations[callSid].lang = "en";
      }
    }

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: conversation,
      });

      let aiResponse = completion.choices[0].message.content;

      conversation.push({ role: "assistant", content: aiResponse });

      if (aiResponse.includes("[END_OF_BOOKING]")) {
        ttsText = aiResponse.replace(
          "[END_OF_BOOKING]",
          "Perfect, your booking is confirmed. We will contact you shortly. Thank you, goodbye."
        );
        finished = true;
      } else {
        ttsText = aiResponse;
      }

    } catch (err) {
      console.error("ERROR OPENAI:", err);
      ttsText = "Sorry, something went wrong.";
    }
  }

  // 🌍 idioma dinámico
  const lang = getTwilioLang(conversations[callSid].lang || "en");

  // 🔊 generar audio SIEMPRE
  let audioUrl = "";
  try {
    const fileName = `resp-${Date.now()}`;
    await generarAudio(ttsText, fileName);
    audioUrl = `https://TU-NGROK/audio/${fileName}.mp3`;
  } catch (err) {
    console.error("ERROR AUDIO:", err);
  }

  // 📡 Twilio response
  let twiml = "";

  if (finished) {
    twiml = `
<Response>
  ${audioUrl ? `<Play>${audioUrl}</Play>` : `<Say>${ttsText}</Say>`}
  <Hangup/>
</Response>
`;
  } else {
    twiml = `
<Response>
  ${audioUrl ? `<Play>${audioUrl}</Play>` : `<Say>${ttsText}</Say>`}
  <Gather input="speech" action="/voice" method="POST" timeout="4" speechTimeout="1" language="${lang}" />
</Response>
`;
  }

  res.type("text/xml").send(twiml);

  // 📦 cerrar
  if (finished) {
    fs.writeFileSync(`turno-${Date.now()}.json`, JSON.stringify(conversation, null, 2));
    await enviarEmail(conversation);
    delete conversations[callSid];
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT}`);
});