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

// 🌍 idioma Twilio
function getTwilioLang(lang) {
  switch (lang) {
    case "es": return "es-ES";
    case "pt": return "pt-BR";
    case "zh": return "zh-CN";
    case "en": return "en-US";
    default: return "en-US";
  }
}

// 🧠 Prompt
const systemPrompt = `
You are a friendly car service receptionist for WORLD CARS.

Speak naturally, short sentences.

SERVICES:
- Standard Service: oil change, oil filter, basic inspection
- Full Service: check website
- Diagnostics: engine issues
- Repairs: brakes, suspension, engine work
- Tyres: ask size + quantity

RULES:
- No invent prices
- Be helpful
- Booking hours: Mon–Fri 7:30–5
- NZ public holidays closed

LANGUAGE:
- Detect and respond in same language (EN, ES, PT, ZH)

BOOKING FLOW:
1. Name + phone
2. Vehicle + plate
3. Service
4. Date/time

Use [END_OF_BOOKING] only when finished.
`;

const conversations = {};

// 🔊 TTS
async function generarAudio(texto, fileName) {
  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: texto,
    speed: 1.1,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(path.join(__dirname, "public", `${fileName}.mp3`), buffer);
}

// 📧 EMAIL
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 🧠 RESUMEN
async function generarResumen(conversation) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [{
      role: "user",
      content: `
Extract booking JSON:
fullName, phone, vehicle, licensePlate, serviceType, dateTime

${conversation.map(m => `${m.role}: ${m.content}`).join("\n")}
`
    }]
  });

  return JSON.parse(completion.choices[0].message.content);
}

// 📧 ENVIAR EMAIL
async function enviarEmail(conversation) {
  const s = await generarResumen(conversation);

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: "info@worldcars.co.nz",
    subject: `Booking: ${s.licensePlate || "??"} | ${s.serviceType || "??"}`,
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

// 📞 VOICE ROUTE
app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult?.trim();

  if (!conversations[callSid]) {
    conversations[callSid] = {
      lang: "en",
      history: [{ role: "system", content: systemPrompt }]
    };
  }

  const session = conversations[callSid];
  const conversation = session.history;

  let ttsText = "";
  let finished = false;

  // 🧠 PRIMER MENSAJE (sin input)
  if (!speech) {
    ttsText = "Hello, welcome to World Cars. Please tell me your full name and phone number.";

  } else {

    // 🚨 fallback anti-silencio
    if (speech.length < 2) {
      ttsText = "Sorry, I didn't hear you clearly. Please repeat your name and phone number.";
    } else {

      conversation.push({ role: "user", content: speech });

      // 🌍 detectar idioma solo 1 vez
      if (!session.langDetected) {
        try {
          const langDetect = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
              role: "user",
              content: `Detect language only: en, es, pt, zh. Text: ${speech}`
            }]
          });

          session.lang = langDetect.choices[0].message.content.trim().toLowerCase();
          session.langDetected = true;

        } catch {
          session.lang = "en";
        }
      }

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
    }
  }

  // 🌍 idioma Twilio
  const lang = getTwilioLang(session.lang || "en");

  // 🔊 audio
  let audioUrl = "";
  try {
    const fileName = `resp-${Date.now()}`;
    await generarAudio(ttsText, fileName);
    audioUrl = `https://TU-NGROK/audio/${fileName}.mp3`;
  } catch (err) {
    console.error("AUDIO ERROR:", err);
  }

  // 📡 TWIML
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
  <Gather input="speech"
          action="/voice"
          method="POST"
          timeout="10"
          speechTimeout="auto"
          language="${lang}">
    <Say>Please speak after the beep.</Say>
  </Gather>
</Response>
`;
  }

  res.type("text/xml").send(twiml);

  // 📦 cerrar booking
  if (finished) {
    fs.writeFileSync(
      `turno-${Date.now()}.json`,
      JSON.stringify(conversation, null, 2)
    );

    await enviarEmail(conversation);
    delete conversations[callSid];
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT}`);
});