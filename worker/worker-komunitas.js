// @ts-nocheck
/* ============================================================
   Worker — Bot Komunitas Masjid/Kantor: Absensi Puasa & Pengingat Kajian
   Backend: GitHub repo (komunitas-data.json) + Telegram Bot API.
   Dipakai untuk SATU grup Telegram yang punya beberapa TOPIK (forum
   topics) — mis. topik "Puasa" dan topik "Kajian" — supaya polling
   puasa dan pengingat kajian tidak campur aduk di satu aliran chat.

   ------------------------------------------------------------
   CARA SETUP TOPIK (WAJIB dilakukan sekali di awal oleh admin grup):
   1. Aktifkan "Topics" di pengaturan grup Telegram (grup harus jadi
      "Forum"). Buat topik, mis. "Puasa" dan "Kajian".
   2. Masuk ke topik "Puasa", kirim: /topik_set puasa
      Masuk ke topik "Kajian", kirim: /topik_set kajian
      Bot akan menyimpan message_thread_id topik itu, jadi tahu ke
      mana harus mengirim pesan untuk masing-masing keperluan.
   3. Cek kapan saja dengan: /topik_daftar
   ------------------------------------------------------------

   Endpoint:
     GET  /data              -> baca komunitas-data.json dari GitHub
     POST /data               -> timpa file itu dengan data baru
     POST /telegram-webhook  -> terima pesan & jawaban poll dari Telegram

   Command Telegram (dikirim di dalam grup):
     /topik_set <nama>      -> daftarkan topik saat ini dgn nama pendek
     /topik_hapus <nama>    -> hapus pendaftaran topik
     /topik_daftar          -> lihat semua topik terdaftar

     /puasa_jadwal <hari...> <jam:menit>
        contoh: /puasa_jadwal senin 05:00
        contoh multi-hari: /puasa_jadwal senin kamis 05:00
     /puasa_off             -> matikan polling otomatis
     /puasa_sekarang        -> kirim polling puasa manual, saat ini juga
     /puasa_rekap           -> rekap siapa sudah menjawab poll HARI INI

     /kajian_tambah <tanggal DD-MM-YYYY> | <pengisi> | <tema>
        contoh: /kajian_tambah 28-08-2026 | Ust. Fulan | Fiqih Puasa Sunnah
     /kajian_list            -> lihat semua jadwal kajian mendatang
     /kajian_hapus <nomor>   -> hapus dari daftar (nomor dari /kajian_list)
     /kajian_reminder <hari...> <jam:menit>
        contoh: /kajian_reminder 7,0 06:00 (H-7 & hari-H, jam 06:00 WIB)

     /kalender_reminder <menit>  -> jeda pengingat event Google Calendar

     /tanya <pertanyaan>     -> tanya bebas ke AI (Groq/Workers AI)
     /puasa_insight          -> catatan singkat AI dari rekap puasa hari ini
     /kuota                  -> lihat pemakaian kuota AI hari ini

     /help                   -> ringkasan semua command

   ENV yang wajib diisi (wrangler.toml [vars] + wrangler secret put):
     - GITHUB_TOKEN               (secret)  Personal Access Token, scope "repo"
     - GITHUB_OWNER                (var)     username/organisasi GitHub Anda
     - GITHUB_REPO                 (var)     nama repo tempat data disimpan
     - GITHUB_BRANCH                (var, opsional, default "main")
     - TELEGRAM_BOT_TOKEN          (secret)  token dari @BotFather (boleh bot
                                              yang sama dgn project hafalan,
                                              boleh juga bot baru terpisah)
     - TELEGRAM_CHAT_ID            (var)     chat_id grup (satu grup saja;
                                              angkanya negatif, mis. -1001234567890)
     - TELEGRAM_WEBHOOK_SECRET     (secret)  string acak, dicocokkan dgn header Telegram
     - TELEGRAM_BOT_USERNAME       (var, opsional) username bot TANPA "@" (mis.
                                    "KomunitasKantorBot") -- dipakai buat deteksi
                                    mention "@namabot" dalam pesan bebas (lihat
                                    fitur "Perintah tanpa / & perintah bebas" di
                                    bawah). DM & reply-ke-bot tetap terdeteksi
                                    normal walau ENV ini kosong.
     - APP_TOKEN                   (secret)  token otorisasi endpoint /data

   ENV OPSIONAL untuk pengingat Google Calendar (kalau tidak diisi,
   fitur ini otomatis nonaktif/diam -- fitur lain tetap jalan normal):
     - GOOGLE_SERVICE_ACCOUNT_EMAIL         (var)     dari file JSON service account
     - GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY   (secret)  dari file JSON service account
     - GOOGLE_CALENDAR_ID                    (var)     Calendar ID yang mau dipantau

   ENV OPSIONAL untuk fitur AI (kalau SEMUA tidak diisi, fitur AI otomatis
   nonaktif/diam — sisa fitur di atas TETAP jalan normal seperti biasa).
   Pola SAMA PERSIS dengan project hafalan: Groq dicoba dulu (gratis &
   lebih pintar), Workers AI jadi cadangan otomatis kalau Groq gagal/
   cooldown/belum dikonfigurasi — DUA-DUANYA cuma pakai tier gratis,
   TIDAK PERNAH lanjut ke provider berbayar:
     - GROQ_API_KEY                (secret)  API key dari console.groq.com
     - AI                          (binding Workers AI, via Cloudflare
                                     Dashboard > Worker > Settings >
                                     Bindings > Add > Workers AI)
     - AI_QUOTA                    (binding KV Namespace — buat dulu di
                                     Storage & Databases > KV > Create,
                                     lalu hubungkan lewat Settings >
                                     Bindings > Add > KV Namespace).
                                     Dipakai buat lacak kuota harian Groq
                                     & Workers AI. Kalau kosong, fitur AI
                                     tetap jalan TAPI TANPA pengaman kuota.

   Cron: didaftarkan TIAP 5 MENIT di Cloudflare Dashboard (Settings >
   Cron Triggers > setiap 5 menit). Sebelumnya cukup tiap jam, tapi
   pengingat Google Calendar butuh presisi menit, jadi interval
   dipersempit -- ini AMAN dipakai bareng fitur puasa/kajian karena
   keduanya sudah punya penanda "sudah terkirim" masing-masing (tidak
   akan dobel kirim walau dicek berkali-kali dalam jam/hari yang sama).
   ============================================================ */

const GITHUB_API = "https://api.github.com";
const TELEGRAM_API = "https://api.telegram.org";
const FILE_PATH = "data/komunitas-data.json"; // di subfolder "data/" karena satu repo dgn source situs adzan & admin
// WAJIB sama persis dengan interval Cron Trigger di Cloudflare Dashboard
// (Settings > Cron Triggers), yaitu tiap 5 menit. Dipakai buat hitung
// jendela toleransi pengingat Google Calendar per-menit di bawah.
const TICK_INTERVAL_MIN = 5;

const HARI_MAP = {
  minggu: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6,
};
const HARI_LABEL = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

// Command yang cuma boleh dipakai admin terdaftar (lihat adminUserIds &
// pengecekan otorisasi di handleTelegramWebhook). Command di luar daftar
// ini (list/rekap/help/tanya/id/dst) tetap terbuka utk semua anggota grup.
const ADMIN_ONLY_COMMANDS = new Set([
  "/topik_set", "/topik_hapus",
  "/puasa_jadwal", "/puasa_off", "/puasa_sekarang",
  "/puasa_pertanyaan", "/puasa_opsi",
  "/kajian_tambah", "/kajian_hapus", "/kajian_reminder",
  "/kajian_jam", "/kajian_lokasi", "/kajian_catatan",
  "/kalender_reminder",
  "/ingat_tambah", "/ingat_hapus", "/ingat_on", "/ingat_off",
  "/admin_tambah", "/admin_hapus",
]);

/* ============================================================
   Perintah tanpa "/" & perintah bebas (natural language)
   ------------------------------------------------------------
   Telegram, secara BAWAAN (Privacy Mode aktif), cuma mengirim pesan grup
   ke bot kalau: diawali "/", membalas (reply) pesan bot, atau mention
   @namabot -- pesan biasa antar anggota TIDAK sampai ke Worker ini sama
   sekali. Supaya command tanpa "/" & kalimat bebas bisa dipakai LANGSUNG
   di tengah grup (bukan cuma lewat reply/mention/DM), Privacy Mode bot
   perlu dimatikan lewat BotFather (/setprivacy -> Disable) -- lihat
   catatan setup di README/panduan instalasi.

   Dua lapis pemahaman pesan yang TIDAK diawali "/":
   1) Cocokkan ke daftar kata kunci command yang dikenal (gratis, cepat,
      tanpa AI) -- lihat normalizeCommandText().
   2) Kalau tidak cocok satu pun, baru dicoba diartikan sebagai kalimat
      bebas lewat AI (interpretFreeCommand()) -- AI diminta MEMETAKAN
      kalimat itu ke salah satu command baku, BUKAN menjawab bebas.
   Supaya bot tidak ikut nimbrung obrolan biasa yang kebetulan sama sekali
   bukan command, tahap ini HANYA dijalankan kalau pesannya jelas
   ditujukan ke bot (DM, reply ke bot, atau mention) -- lihat
   isMessageDirectedAtBot(). Ini pengaman terpisah dari Privacy Mode di
   atas: dua-duanya perlu benar supaya fitur ini terasa natural TAPI
   tidak berisik.
   ============================================================ */
const KNOWN_COMMAND_WORDS = new Set([
  "topik_set", "topik_hapus", "topik_daftar",
  "puasa_jadwal", "puasa_off", "puasa_sekarang", "puasa_rekap", "puasa_insight",
  "puasa_pertanyaan", "puasa_opsi",
  "kajian_tambah", "kajian_list", "kajian_hapus", "kajian_reminder",
  "kajian_jam", "kajian_lokasi", "kajian_catatan",
  "kalender_reminder",
  "ingat_tambah", "ingat_list", "ingat_hapus", "ingat_on", "ingat_off",
  "admin_tambah", "admin_hapus", "admin_daftar",
  "id", "kuota", "help", "tanya",
]);
/* Ubah "topik_daftar", "/topik_daftar", atau "/topik_set@NamaBot puasa"
   jadi bentuk baku "/topik_set puasa" -- supaya SEMUA pengecekan
   text.startsWith("/xxx") di bawah tetap jalan apa adanya, tanpa perlu
   diubah satu-satu. Balikin null kalau kata pertamanya bukan command
   yang dikenal (berarti bukan command sama sekali). */
function normalizeCommandText(raw) {
  const m = raw.trim().match(/^\/?([a-zA-Z_]+)(@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (!KNOWN_COMMAND_WORDS.has(word)) return null;
  const rest = m[3] || "";
  return "/" + word + (rest ? " " + rest : "");
}
/* DM ke bot, reply ke pesan bot, atau mention @namabot -> dianggap jelas
   ditujukan ke bot. TELEGRAM_BOT_USERNAME (opsional, ENV) dibutuhkan
   supaya deteksi mention jalan -- tanpa itu, DM & reply tetap terdeteksi
   normal, cuma mention yang tidak bisa dicek. */
function isMessageDirectedAtBot(env, msg) {
  if (msg.chat && msg.chat.type === "private") return true;
  if (msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot) return true;
  if (env.TELEGRAM_BOT_USERNAME && msg.text.toLowerCase().includes("@" + env.TELEGRAM_BOT_USERNAME.toLowerCase())) return true;
  return false;
}
/* Minta AI memetakan SATU kalimat bebas ke SATU baris command baku.
   Balikin: string "/command ..." kalau cocok, "TIDAK_DIKENALI" kalau
   tidak cocok apa pun, "PERLU_INFO: ..." kalau cocok tapi info penting
   (tanggal/jam/nomor/dll) belum disebutkan pengguna, atau null kalau AI
   sendiri sedang tidak tersedia (belum dikonfigurasi/kuota habis). */
async function interpretFreeCommand(env, freeText) {
  const daftarCommand = [
    "/topik_daftar -- lihat topik terdaftar",
    "/topik_set <nama> -- daftarkan topik saat ini (cuma jalan kalau dikirim di dalam topik tsb)",
    "/topik_hapus <nama>",
    "/puasa_jadwal <hari...> <jam:menit> -- atur jadwal polling puasa, contoh hari: senin, kamis",
    "/puasa_pertanyaan <teks> -- atur teks pertanyaan poll puasa",
    "/puasa_opsi <opsi1> | <opsi2> -- atur 2 pilihan jawaban poll puasa",
    "/puasa_off -- matikan polling puasa otomatis",
    "/puasa_sekarang -- kirim polling puasa manual saat ini juga",
    "/puasa_rekap -- lihat siapa sudah jawab puasa hari ini",
    "/puasa_insight -- catatan AI dari rekap puasa hari ini",
    "/kajian_tambah <DD-MM-YYYY> | <pengisi> | <tema>",
    "/kajian_list -- lihat kajian mendatang",
    "/kajian_hapus <nomor>",
    "/kajian_reminder <hari,hari> <jam:menit> -- atur H- berapa hari & jam berapa kajian diingatkan",
    "/kajian_jam <HH:MM> -- jam mulai acara kajian sesungguhnya",
    "/kajian_lokasi <teks> -- lokasi acara, mis. Mushollah",
    "/kajian_catatan <teks> -- info tambahan yg muncul di tiap reminder kajian",
    "/kalender_reminder <menit> -- jeda pengingat sebelum event Google Calendar mulai",
    "/ingat_tambah <topik> | <judul> | <pesan> | <jadwal> -- jadwal: 'sekali DD-MM-YYYY HH:MM' / 'harian HH:MM' / 'mingguan hari,hari HH:MM' / 'bulanan tanggal HH:MM'",
    "/ingat_list -- lihat pengingat umum",
    "/ingat_hapus <nomor>",
    "/ingat_on <nomor>",
    "/ingat_off <nomor>",
    "/admin_tambah [user_id] -- tanpa argumen = tambah diri sendiri",
    "/admin_hapus <user_id>",
    "/admin_daftar -- lihat admin terdaftar",
    "/id -- lihat ID Telegram sendiri",
    "/kuota -- cek kuota AI",
    "/help -- daftar semua perintah",
  ].join("\n");
  const hasil = await callAiTextDual(
    env,
    "Kamu interpreter perintah bot Telegram komunitas masjid/kantor. Tugasmu HANYA mengubah kalimat bebas pengguna jadi SATU baris command baku dari daftar ini:\n\n" +
      daftarCommand +
      "\n\nATURAN KETAT:\n" +
      "- Balas HANYA satu baris command itu (format persis seperti contoh, isi <placeholder> dgn nilai dari kalimat pengguna), TANPA penjelasan, TANPA tanda kutip, TANPA basa-basi.\n" +
      "- Kalau kalimat pengguna tidak cocok satu pun command di atas (mis. cuma obrolan biasa atau pertanyaan umum), balas PERSIS: TIDAK_DIKENALI\n" +
      "- Kalau cocok salah satu command tapi ada info WAJIB yang tidak disebutkan pengguna (mis. tanggal/jam/nomor/tema), balas PERSIS: PERLU_INFO: <sebutkan singkat apa yang kurang, Bahasa Indonesia> -- JANGAN PERNAH menebak-nebak nilai yang tidak disebutkan.\n" +
      "- Tanggal SELALU format DD-MM-YYYY. Kalau pengguna sebut 'besok'/'minggu depan'/dst tanpa tanggal pasti, itu masuk kategori PERLU_INFO (minta tanggal pasti), jangan dihitung sendiri.",
    freeText,
    120
  );
  return hasil ? hasil.trim() : null;
}

const DEFAULT_DATA = {
  // ID Telegram (angka) yang boleh pakai perintah PENGATURAN (topik, jadwal,
  // tambah/hapus kajian, dst). Command lihat-lihat (list/rekap/help/tanya)
  // tetap terbuka utk semua anggota grup, tidak kena batasan ini.
  // Kalau list ini KOSONG, semua orang masih boleh pakai semua command
  // (default aman/tidak mengunci siapa pun) -- proteksi baru aktif begitu
  // admin pertama ditambahkan lewat /admin_tambah.
  adminUserIds: [],
  topics: {
    // nama_pendek: { threadId: number, label: string }
  },
  puasaPoll: {
    enabled: false,
    days: [], // KOSONG sampai diatur manual lewat /puasa_jadwal
    time: null, // HH:MM WIB -- WAJIB diisi manual, tidak ada bawaan
    question: null, // WAJIB diisi manual lewat /puasa_pertanyaan atau panel admin
    options: [], // WAJIB diisi manual lewat /puasa_opsi atau panel admin
  },
  kajian: [
    // { id, tanggal: "YYYY-MM-DD", pengisi, tema, remindersSent: [7, 0] }
  ],
  // pengaturan pengingat kajian -- SEMUA kosong/null sampai diatur manual.
  // Kalau offsetsDays/time belum diisi, TIDAK ADA reminder kajian yang
  // terkirim (bukan diam-diam pakai bawaan H-7/H-0 jam 06:00 spt versi lama).
  kajianSettings: {
    offsetsDays: [],   // isi manual lewat /kajian_reminder, mis. "7,0"
    time: null,        // jam pengingat dikirim, WAJIB diisi manual
    jamAcara: null,    // jam mulai acara sesungguhnya, WAJIB diisi manual lewat /kajian_jam
    lokasi: "",        // isi manual lewat /kajian_lokasi kalau mau ditampilkan
    catatan: "",       // isi manual lewat /kajian_catatan kalau mau ditampilkan
  },
  // pengingat Google Calendar: dikirim sekian MENIT sebelum event mulai.
  // null = fitur ini TIDAK aktif sampai diisi manual lewat /kalender_reminder.
  calendarReminderMinutes: null,
  calendarRemindedIds: [], // event.id yang sudah pernah diingatkan, cegah dobel kirim

  // pengingat umum (custom): bebas judul/pesan/topik/jadwal, dibuat lewat
  // command /ingat_tambah ATAU panel admin -- dua-duanya baca/tulis data
  // yang sama.
  reminders: [
    // { id, title, message, topicKey, schedule:{type,time,date?,daysOfWeek?,dayOfMonth?}, enabled, lastSentDate, googleEventId? }
  ],
  // log jawaban poll (dibersihkan otomatis, simpan 30 hari terakhir)
  // key: "YYYY-MM-DD" -> { pollId, chatId, threadId, answers: { userId: {name, choice} } }
  puasaLog: {},
  // tanggal terakhir polling & reminder terkirim, cegah kirim dobel
  lastPuasaPollSentDate: null,
  lastKajianCheckDate: null,
};

/* ---------- CATATAN TIMEZONE ----------
   Cloudflare Workers cron berjalan di UTC. WIB = UTC+7. Supaya
   /puasa_jadwal "05:00" itu maksudnya 05:00 WIB, semua perbandingan jam
   di scheduled() di bawah dikonversi eksplisit ke waktu Jakarta (WIB),
   BUKAN membandingkan jam UTC mentah -- lihat nowInJakarta(). */
function nowInJakarta() {
  // WIB = UTC+7, tidak ada DST di Indonesia -- aman di-hardcode.
  const now = new Date();
  return new Date(now.getTime() + 7 * 3600 * 1000);
}
function jakartaDateStr(d) {
  // d harus sudah hasil nowInJakarta() (sudah digeser +7 tapi masih
  // dibaca pakai getUTC* biar tidak digeser DUA KALI oleh timezone lokal runtime)
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
  });
}

function isAuthorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.APP_TOKEN}`;
}

/* ---------------- GitHub sebagai database ---------------- */
async function githubGetFile(env) {
  const branch = env.GITHUB_BRANCH || "main";
  const url = `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${FILE_PATH}?ref=${branch}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "worker-komunitas",
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) {
    return { data: structuredClone(DEFAULT_DATA), sha: null };
  }
  if (!res.ok) throw new Error("Gagal baca file dari GitHub: " + res.status);
  const body = await res.json();
  const content = JSON.parse(atob(body.content.replace(/\n/g, "")));
  return { data: Object.assign(structuredClone(DEFAULT_DATA), content), sha: body.sha };
}

async function githubPutFile(env, data, sha) {
  const branch = env.GITHUB_BRANCH || "main";
  const url = `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${FILE_PATH}`;
  const body = {
    message: "update komunitas-data.json via bot",
    content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))),
    branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "worker-komunitas",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Gagal tulis file ke GitHub: " + res.status + " " + (await res.text()));
  return res.json();
}

/* ---------------- Telegram helpers ---------------- */
async function tg(env, method, payload) {
  const res = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}
async function sendMessage(env, text, threadId) {
  const payload = { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" };
  if (threadId) payload.message_thread_id = threadId;
  return tg(env, "sendMessage", payload);
}
async function sendPoll(env, question, options, threadId) {
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    question,
    options,
    is_anonymous: false, // WAJIB false supaya bot bisa lihat siapa jawab apa (poll_answer)
    allows_multiple_answers: false,
  };
  if (threadId) payload.message_thread_id = threadId;
  return tg(env, "sendPoll", payload);
}

function threadIdOf(data, key) {
  return data.topics[key] ? data.topics[key].threadId : undefined;
}

/* ============================================================
   AI — pola SAMA PERSIS dengan project hafalan Anda: Groq (utama,
   gratis & lebih pintar) dicoba dulu, Workers AI (cadangan) otomatis
   dipakai kalau Groq gagal/cooldown/belum dikonfigurasi. DUA-DUANYA
   cuma pakai tier gratis, TIDAK PERNAH lanjut ke provider berbayar.
   ============================================================ */
const WORKERS_AI_TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const WORKERS_AI_DAILY_NEURON_BUDGET = 8000; // buffer aman di bawah kuota gratis 10.000/hari
const WORKERS_AI_NEURON_ESTIMATE = { [WORKERS_AI_TEXT_MODEL]: 15 };

const GROQ_API = "https://api.groq.com/openai/v1";
const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";
const GROQ_DAILY_TOKEN_BUDGET = { [GROQ_TEXT_MODEL]: 80000 }; // pengaman KEDUA, independen dari cooldown reaktif

function groqCooldownKV(model) { return "groqcooldown:" + model + ":" + jakartaDateStr(nowInJakarta()); }
function groqTokensKV(model) { return "groqtokens:" + model + ":" + jakartaDateStr(nowInJakarta()); }
async function isGroqCoolingDown(env, model) {
  if (!env.AI_QUOTA) return false;
  return !!(await env.AI_QUOTA.get(groqCooldownKV(model)));
}
async function setGroqCooldown(env, model) {
  if (!env.AI_QUOTA) return;
  await env.AI_QUOTA.put(groqCooldownKV(model), "1", { expirationTtl: 60 * 60 * 20 }); // ~20 jam, pulih sendiri besoknya
}
async function getGroqTokenUsage(env, model) {
  if (!env.AI_QUOTA) return 0;
  const raw = await env.AI_QUOTA.get(groqTokensKV(model));
  return raw ? Number(raw) || 0 : 0;
}
async function addGroqTokenUsage(env, model, tokens) {
  if (!env.AI_QUOTA || !tokens) return;
  const cur = await getGroqTokenUsage(env, model);
  await env.AI_QUOTA.put(groqTokensKV(model), String(cur + tokens), { expirationTtl: 60 * 60 * 36 });
}
async function hasGroqTokenBudget(env, model) {
  const budget = GROQ_DAILY_TOKEN_BUDGET[model];
  if (!budget || !env.AI_QUOTA) return true;
  return (await getGroqTokenUsage(env, model)) < budget;
}
async function callGroqText(env, systemPrompt, userContent, maxTokens) {
  if (!env.GROQ_API_KEY) throw new Error("GROQ_NOT_CONFIGURED");
  if (await isGroqCoolingDown(env, GROQ_TEXT_MODEL)) throw new Error("GROQ_COOLDOWN");
  if (!(await hasGroqTokenBudget(env, GROQ_TEXT_MODEL))) throw new Error("GROQ_BUDGET_EXCEEDED");
  const res = await fetch(GROQ_API + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.GROQ_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_TEXT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
    }),
  });
  const remainingReq = parseInt(res.headers.get("x-ratelimit-remaining-requests") || "", 10);
  if (!Number.isNaN(remainingReq) && remainingReq <= 3) await setGroqCooldown(env, GROQ_TEXT_MODEL);
  if (!res.ok) {
    if (res.status === 429) await setGroqCooldown(env, GROQ_TEXT_MODEL);
    throw new Error("GROQ_HTTP_" + res.status);
  }
  const data = await res.json().catch(() => null);
  const usedTokens = data && data.usage && typeof data.usage.total_tokens === "number" ? data.usage.total_tokens : 0;
  if (usedTokens > 0) await addGroqTokenUsage(env, GROQ_TEXT_MODEL, usedTokens);
  const text = data && data.choices && data.choices[0] && data.choices[0].message ? String(data.choices[0].message.content || "").trim() : "";
  return text;
}
async function getNeuronUsage(env) {
  if (!env.AI_QUOTA) return 0;
  const raw = await env.AI_QUOTA.get("neurons:" + jakartaDateStr(nowInJakarta()));
  return raw ? Number(raw) : 0;
}
async function addNeuronUsage(env, model) {
  if (!env.AI_QUOTA) return;
  const key = "neurons:" + jakartaDateStr(nowInJakarta());
  const used = await getNeuronUsage(env);
  const estimate = WORKERS_AI_NEURON_ESTIMATE[model] || 20;
  await env.AI_QUOTA.put(key, String(used + estimate), { expirationTtl: 172800 });
}
async function hasNeuronBudget(env, model) {
  if (!env.AI_QUOTA) return true;
  const used = await getNeuronUsage(env);
  const estimate = WORKERS_AI_NEURON_ESTIMATE[model] || 20;
  return used + estimate <= WORKERS_AI_DAILY_NEURON_BUDGET;
}
async function runAiGuarded(env, model, input) {
  if (!env.AI) throw new Error("AI_NOT_CONFIGURED");
  if (!(await hasNeuronBudget(env, model))) throw new Error("AI_QUOTA_EXCEEDED");
  const res = await env.AI.run(model, input);
  await addNeuronUsage(env, model);
  return res;
}
/* Pemanggil AI terpadu dua lapis -- Groq dulu, Workers AI cadangan.
   Dipakai SEMUA fitur AI teks di bot ini. Kegagalan Groq selalu diam-
   diam (dicatat log saja) sebelum lanjut ke Workers AI. Balikin string,
   atau null kalau dua-duanya gagal/kuota habis. */
async function callAiTextDual(env, systemPrompt, userContent, maxTokens) {
  try {
    const text = await callGroqText(env, systemPrompt, userContent, maxTokens);
    if (text) return text;
  } catch (e) {
    console.log("Groq teks gagal/dilewati (" + String((e && e.message) || e) + "), coba Workers AI...");
  }
  try {
    const res = await runAiGuarded(env, WORKERS_AI_TEXT_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
    });
    let text = "";
    if (typeof res?.response === "string") text = res.response;
    else if (res?.response && typeof res.response === "object") text = res.response.content || res.response.text || JSON.stringify(res.response);
    return String(text || "").trim() || null;
  } catch (e) {
    console.log("Workers AI teks juga gagal:", String((e && e.message) || e));
    return null;
  }
}
async function getAiQuotaStatus(env) {
  const dateKey = jakartaDateStr(nowInJakarta());
  const wUsed = await getNeuronUsage(env);
  let groqUsed = 0, groqCooldown = false;
  const groqBudget = GROQ_DAILY_TOKEN_BUDGET[GROQ_TEXT_MODEL] || null;
  if (env.AI_QUOTA) {
    try {
      groqUsed = await getGroqTokenUsage(env, GROQ_TEXT_MODEL);
      groqCooldown = await isGroqCoolingDown(env, GROQ_TEXT_MODEL);
    } catch (e) {}
  }
  return {
    dateLabel: dateKey,
    groqConfigured: !!env.GROQ_API_KEY,
    groq: { usedTokens: groqUsed, budgetTokens: groqBudget, percent: groqBudget ? Math.min(100, Math.round((groqUsed / groqBudget) * 1000) / 10) : null, cooldown: groqCooldown },
    workersAiConfigured: !!env.AI,
    workersAi: { usedNeuron: wUsed, budgetNeuron: WORKERS_AI_DAILY_NEURON_BUDGET, percent: Math.min(100, Math.round((wUsed / WORKERS_AI_DAILY_NEURON_BUDGET) * 1000) / 10) },
    quotaTrackingActive: !!env.AI_QUOTA,
    aiConfigured: !!env.AI || !!env.GROQ_API_KEY,
  };
}
function buildAiQuotaMessage(status) {
  if (!status.aiConfigured) return "Fitur AI belum dikonfigurasi (GROQ_API_KEY & binding \"AI\" dua-duanya belum diisi) — /tanya dan /puasa_insight tidak akan jalan, fitur lain tetap normal.";
  const lines = ["📊 <b>Kuota AI hari ini</b> (" + status.dateLabel + " WIB)", ""];
  lines.push(status.groqConfigured
    ? "Groq (utama): " + (status.groq.budgetTokens != null ? status.groq.usedTokens + " / " + status.groq.budgetTokens + " token (" + status.groq.percent + "%)" : (status.groq.cooldown ? "⚠️ mendekati limit" : "✓ normal"))
    : "Groq (utama): belum dikonfigurasi — langsung pakai Workers AI.");
  lines.push("Workers AI (cadangan): " + status.workersAi.usedNeuron + " / " + status.workersAi.budgetNeuron + " Neuron (" + status.workersAi.percent + "%)");
  if (!status.quotaTrackingActive) lines.push("", "Catatan: KV \"AI_QUOTA\" belum diisi — angka di atas belum terlacak sungguhan (AI tetap jalan tapi tanpa pengaman kuota).");
  return lines.join("\n");
}

/* ---------------- Google Calendar (via Service Account) ----------------
   Tidak pakai OAuth login pengguna (yang perlu refresh token & bisa
   kadaluarsa) -- pakai Service Account: akun "robot" Google yang
   di-invite sebagai pembaca ke calendar privat yang mau dipantau.
   Worker menandatangani JWT sendiri (RS256) pakai private key service
   account, tukar ke access token, lalu panggil Calendar API biasa.
   ------------------------------------------------------------
   SETUP (sekali saja):
   1. console.cloud.google.com -> buat/pilih project -> aktifkan
      "Google Calendar API".
   2. IAM & Admin > Service Accounts > Create Service Account (tidak
      perlu kasih role apa pun).
   3. Buka service account itu > Keys > Add Key > Create new key > JSON
      -> unduh filenya.
   4. Dari file JSON itu:
        - "client_email"  -> ENV GOOGLE_SERVICE_ACCOUNT_EMAIL
        - "private_key"   -> ENV GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (secret)
          (isi apa adanya termasuk "-----BEGIN PRIVATE KEY-----" dst;
          kalau ada karakter \n literal di dalamnya itu normal, sudah
          ditangani otomatis oleh kode di bawah)
   5. Buka calendar.google.com -> Settings kalender yang mau dipantau ->
      "Share with specific people" -> tambahkan email service account
      (dari langkah 4) dengan akses "Make changes to events" (BUKAN cuma
      "See all event details" -- worker ini sekarang juga MENULIS event
      baru ke calendar, bukan cuma membaca).
   6. Masih di Settings kalender itu -> bagian "Integrate calendar" ->
      salin "Calendar ID" -> ENV GOOGLE_CALENDAR_ID.
   ------------------------------------------------------------ */
function base64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemToArrayBuffer(pem) {
  const normalized = pem.replace(/\\n/g, "\n"); // jaga2 kalau tersimpan sbg \n literal (umum kalau copy dari JSON)
  const b64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // scope PENUH (baca+tulis), bukan cuma readonly -- worker ini baca
    // event (pengingat H-sekian menit) DAN menulis event baru (sinkron
    // kajian & pengingat umum ke Google Calendar).
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const signInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signInput));
  const jwt = `${signInput}.${base64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error("Gagal dapat token Google: " + JSON.stringify(json));
  return json.access_token;
}
async function fetchUpcomingCalendarEvents(env) {
  const token = await getGoogleAccessToken(env);
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + 2 * 86400000).toISOString(); // 2 hari ke depan cukup buat pengingat "beberapa menit sebelum mulai"
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events` +
    `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Gagal ambil event kalender: " + res.status + " " + (await res.text()));
  const data = await res.json();
  return data.items || [];
}

/* Bikin string ISO datetime WIB (+07:00) dari tanggal "YYYY-MM-DD" & jam "HH:MM". */
function wibISO(dateStr, timeStr) {
  return `${dateStr}T${timeStr}:00+07:00`;
}
/* Tambah menit ke ISO WIB, balikin ISO WIB baru -- dipakai hitung jam
   selesai event dari jam mulai + durasi. */
function addMinutesWibISO(iso, minutes) {
  const d = new Date(new Date(iso).getTime() + minutes * 60000);
  const shifted = new Date(d.getTime() + 7 * 3600000); // baca sbg jam dinding WIB, pola sama seperti nowInJakarta()
  const y = shifted.getUTCFullYear(), mo = String(shifted.getUTCMonth() + 1).padStart(2, "0"), da = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0"), mi = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da}T${hh}:${mi}:00+07:00`;
}
/* Ubah schedule pengingat umum jadi RRULE Google Calendar (recurring
   event asli) -- kosong/undefined utk tipe "once" (event sekali jadi). */
function scheduleToRRule(schedule) {
  const DOW = { 0: "SU", 1: "MO", 2: "TU", 3: "WE", 4: "TH", 5: "FR", 6: "SA" };
  if (schedule.type === "daily") return ["RRULE:FREQ=DAILY"];
  if (schedule.type === "weekly") return [`RRULE:FREQ=WEEKLY;BYDAY=${(schedule.daysOfWeek || []).map((d) => DOW[d]).join(",")}`];
  if (schedule.type === "monthly") return [`RRULE:FREQ=MONTHLY;BYMONTHDAY=${schedule.dayOfMonth}`];
  return undefined; // "once" -> tanpa recurrence
}
async function createGoogleCalendarEvent(env, { summary, description, startISO, endISO, recurrence }) {
  const token = await getGoogleAccessToken(env);
  const body = {
    summary,
    description,
    start: { dateTime: startISO, timeZone: "Asia/Jakarta" },
    end: { dateTime: endISO, timeZone: "Asia/Jakarta" },
  };
  if (recurrence) body.recurrence = recurrence;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Gagal buat event kalender: " + res.status + " " + (await res.text()));
  return res.json();
}
async function deleteGoogleCalendarEvent(env, eventId) {
  try {
    const token = await getGoogleAccessToken(env);
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.log("Gagal hapus event kalender (diabaikan):", (e && e.message) || e);
  }
}
function googleCalendarReady(env) {
  return !!(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && env.GOOGLE_CALENDAR_ID);
}
/* Sinkron SATU kajian ke Google Calendar (dipanggil pas /kajian_tambah
   ATAU tambah lewat panel admin). Best-effort -- gagal sinkron TIDAK
   membatalkan penyimpanan kajian itu sendiri, cuma dicatat ke log.
   WAJIB jamAcara sudah diisi manual (/kajian_jam) -- kalau belum, sinkron
   dilewati (bukan diam-diam pakai jam bawaan). */
async function syncKajianToCalendar(env, k, data) {
  if (!googleCalendarReady(env)) return null;
  const jam = data && data.kajianSettings && data.kajianSettings.jamAcara;
  if (!jam) return null; // jam belum diatur manual -> jangan sinkron dulu drpd nebak jam
  try {
    const lokasi = (data && data.kajianSettings && data.kajianSettings.lokasi) || "";
    const startISO = wibISO(k.tanggal, jam);
    const ev = await createGoogleCalendarEvent(env, {
      summary: "📚 Kajian: " + k.tema,
      description: `Pengisi: ${k.pengisi}` + (lokasi ? `\nLokasi: ${lokasi}` : ""),
      startISO,
      endISO: addMinutesWibISO(startISO, 90),
    });
    return ev.id || null;
  } catch (e) {
    console.log("Gagal sinkron kajian ke Google Calendar:", (e && e.message) || e);
    return null;
  }
}
/* Sinkron SATU pengingat umum ke Google Calendar -- recurring event asli
   kalau tipe harian/mingguan/bulanan, event sekali jadi kalau tipe "once". */
async function syncReminderToCalendar(env, r) {
  if (!googleCalendarReady(env)) return null;
  try {
    const anchorDate = r.schedule.type === "once" ? r.schedule.date : jakartaDateStr(nowInJakarta());
    const startISO = wibISO(anchorDate, r.schedule.time);
    const ev = await createGoogleCalendarEvent(env, {
      summary: "🔔 " + r.title,
      description: r.message,
      startISO,
      endISO: addMinutesWibISO(startISO, 30),
      recurrence: scheduleToRRule(r.schedule),
    });
    return ev.id || null;
  } catch (e) {
    console.log("Gagal sinkron pengingat ke Google Calendar:", (e && e.message) || e);
    return null;
  }
}

/* ---------------- Webhook: proses pesan & jawaban poll ---------------- */
async function handleTelegramWebhook(request, env) {
  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Unauthorized" }, 401);

  const update = await request.json();

  // ---------- jawaban poll (poll_answer) ----------
  if (update.poll_answer) {
    await handlePollAnswer(env, update.poll_answer);
    return json({ ok: true });
  }

  // ---------- pesan teks (command / perintah bebas) ----------
  const msg = update.message;
  if (!msg || !msg.text) return json({ ok: true });

  const threadId = msg.message_thread_id || null;
  let text = msg.text.trim();

  if (text.startsWith("/")) {
    // Command formal spt biasa -- tetap dukung "/topik_set@NamaBot" (Telegram
    // suka nempel @namabot di command grup), dibuang lewat normalizeCommandText.
    const normalized = normalizeCommandText(text);
    if (normalized) text = normalized;
  } else {
    // Tanpa "/" di depan. SUPAYA BOT TIDAK IKUT NIMBRUNG obrolan biasa antar
    // anggota grup, ini cuma diproses kalau pesannya memang ditujukan ke bot:
    // chat pribadi (DM), reply ke pesan bot, atau mention @namabot.
    if (!isMessageDirectedAtBot(env, msg)) return json({ ok: true });

    const normalized = normalizeCommandText(text);
    if (normalized) {
      text = normalized; // cocok kata kunci command dikenal persis -> gratis, tanpa AI
    } else {
      // Tidak cocok kata kunci mana pun -> coba pahami sbg kalimat bebas via AI.
      const interpreted = await interpretFreeCommand(env, text);
      if (interpreted === null) {
        await sendMessage(env, "🤖 Fitur perintah bebas butuh AI yang belum aktif di Worker (cek ENV GROQ_API_KEY / binding AI). Sementara pakai command langsung dulu, contoh: /help", threadId);
        return json({ ok: true });
      }
      if (interpreted.startsWith("PERLU_INFO")) {
        await sendMessage(env, "🤔 " + interpreted.replace(/^PERLU_INFO:?\s*/, ""), threadId);
        return json({ ok: true });
      }
      if (interpreted === "TIDAK_DIKENALI" || !interpreted.startsWith("/")) {
        await sendMessage(env, "🤔 Maaf, saya belum paham maksudnya. Ketik /help untuk lihat semua perintah yang saya mengerti.", threadId);
        return json({ ok: true });
      }
      text = interpreted;
    }
  }

  const { data, sha } = await githubGetFile(env);

  // ---------- otorisasi: sebagian command khusus admin terdaftar ----------
  // Kalau adminUserIds masih kosong, tidak ada yang dibatasi (aman buat
  // yang baru pasang bot & belum sempat /admin_tambah). Begitu ada isinya,
  // command di ADMIN_ONLY_COMMANDS wajib dari salah satu ID di daftar itu.
  data.adminUserIds = data.adminUserIds || [];
  const cmdWord = text.split(/\s+/)[0].toLowerCase();
  if (ADMIN_ONLY_COMMANDS.has(cmdWord) && data.adminUserIds.length > 0 && !data.adminUserIds.includes(msg.from.id)) {
    await sendMessage(
      env,
      `⛔ Perintah ini khusus admin terdaftar.\n\nID Telegram Anda: <code>${msg.from.id}</code>\nMinta admin menambahkan Anda lewat: <code>/admin_tambah ${msg.from.id}</code>`,
      threadId
    );
    return json({ ok: true });
  }

  let reply = null;
  let mutated = true;

  if (text.startsWith("/topik_set")) {
    const nama = text.split(" ").slice(1).join(" ").trim().toLowerCase();
    if (!nama) {
      reply = "Format: /topik_set <nama_pendek>\nContoh: /topik_set puasa";
      mutated = false;
    } else if (!threadId) {
      reply = "Command ini harus dikirim DI DALAM topik yang mau didaftarkan (bukan di percakapan umum grup).";
      mutated = false;
    } else {
      data.topics[nama] = { threadId, label: msg.reply_to_message?.forum_topic_created?.name || nama };
      reply = `✅ Topik ini terdaftar sebagai "<b>${nama}</b>" (thread_id: ${threadId}).`;
    }
  } else if (text.startsWith("/topik_hapus")) {
    const nama = text.split(" ").slice(1).join(" ").trim().toLowerCase();
    if (data.topics[nama]) {
      delete data.topics[nama];
      reply = `🗑️ Topik "${nama}" dihapus dari daftar.`;
    } else {
      reply = `Tidak ada topik terdaftar dengan nama "${nama}".`;
      mutated = false;
    }
  } else if (text.startsWith("/topik_daftar")) {
    const list = Object.entries(data.topics);
    reply = list.length
      ? "📋 Topik terdaftar:\n" + list.map(([k, v]) => `• <b>${k}</b> — thread_id ${v.threadId}`).join("\n")
      : "Belum ada topik terdaftar. Kirim /topik_set <nama> di dalam topik yang mau dipakai.";
    mutated = false;
  } else if (text.startsWith("/puasa_jadwal")) {
    const parts = text.split(" ").slice(1);
    const timeToken = parts.find((p) => /^\d{1,2}:\d{2}$/.test(p));
    const dayTokens = parts.filter((p) => HARI_MAP[p.toLowerCase()] !== undefined);
    if (!timeToken || dayTokens.length === 0) {
      reply = "Format: /puasa_jadwal <hari...> <jam:menit>\nContoh: /puasa_jadwal senin 05:00\nContoh multi-hari: /puasa_jadwal senin kamis 05:00";
      mutated = false;
    } else {
      data.puasaPoll.enabled = true;
      data.puasaPoll.days = dayTokens.map((d) => HARI_MAP[d.toLowerCase()]);
      data.puasaPoll.time = timeToken;
      const belumLengkap = !data.puasaPoll.question || !data.puasaPoll.options || data.puasaPoll.options.length < 2;
      reply = `✅ Polling puasa dijadwalkan tiap <b>${dayTokens.map((d) => HARI_LABEL[HARI_MAP[d.toLowerCase()]]).join(", ")}</b> jam <b>${timeToken} WIB</b>.\nPastikan topik "puasa" sudah didaftarkan (/topik_daftar).` +
        (belumLengkap ? "\n\n⚠️ Pertanyaan & opsi poll BELUM diatur, jadi belum akan terkirim. Atur dulu dengan /puasa_pertanyaan dan /puasa_opsi." : "");
    }
  } else if (text.startsWith("/puasa_pertanyaan")) {
    const pertanyaan = text.replace("/puasa_pertanyaan", "").trim();
    if (!pertanyaan) {
      reply = "Format: /puasa_pertanyaan <teks>\nContoh: /puasa_pertanyaan Puasa hari ini?";
      mutated = false;
    } else {
      data.puasaPoll.question = pertanyaan;
      reply = `✅ Pertanyaan poll diset: "${pertanyaan}"`;
    }
  } else if (text.startsWith("/puasa_opsi")) {
    const opsiRaw = text.replace("/puasa_opsi", "").trim();
    const opsi = opsiRaw.split("|").map((s) => s.trim()).filter(Boolean);
    if (opsi.length < 2) {
      reply = "Format: /puasa_opsi <opsi 1> | <opsi 2>\nContoh: /puasa_opsi Puasa | Tidak puasa";
      mutated = false;
    } else {
      data.puasaPoll.options = opsi.slice(0, 2); // Telegram poll di sini didesain 2 opsi (puasa/tidak) -- lihat /puasa_rekap
      reply = `✅ Opsi poll diset: "${opsi[0]}" / "${opsi[1]}"`;
    }
  } else if (text.startsWith("/puasa_off")) {
    data.puasaPoll.enabled = false;
    reply = "⏸️ Polling puasa otomatis dimatikan.";
  } else if (text.startsWith("/puasa_sekarang")) {
    if (!data.puasaPoll.question || !data.puasaPoll.options || data.puasaPoll.options.length < 2) {
      reply = "⚠️ Pertanyaan & opsi poll belum diatur. Atur dulu dengan /puasa_pertanyaan dan /puasa_opsi, baru coba lagi.";
      mutated = false;
    } else {
    const tid = threadIdOf(data, "puasa");
    const res = await sendPoll(env, data.puasaPoll.question, data.puasaPoll.options, tid);
    if (res.ok) {
      const key = jakartaDateStr(nowInJakarta());
      data.puasaLog[key] = { pollId: res.result.poll.id, threadId: tid, answers: {} };
      reply = "📊 Polling puasa dikirim.";
    } else {
      reply = "❌ Gagal kirim polling: " + (res.description || "unknown error");
      mutated = false;
    }
    }
  } else if (text.startsWith("/puasa_rekap")) {
    const key = jakartaDateStr(nowInJakarta());
    const log = data.puasaLog[key];
    mutated = false;
    if (!log || Object.keys(log.answers).length === 0) {
      reply = "Belum ada jawaban polling puasa untuk hari ini (atau polling belum dikirim).";
    } else {
      const puasa = Object.values(log.answers).filter((a) => a.choice === 0);
      const tidak = Object.values(log.answers).filter((a) => a.choice === 1);
      reply =
        `📊 <b>Rekap Puasa — ${key}</b>\n\n` +
        `🟢 Puasa (${puasa.length}):\n${puasa.map((a) => "• " + a.name).join("\n") || "-"}\n\n` +
        `⚪ Tidak puasa (${tidak.length}):\n${tidak.map((a) => "• " + a.name).join("\n") || "-"}`;
    }
  } else if (text.startsWith("/kajian_tambah")) {
    const body = text.replace("/kajian_tambah", "").trim();
    const [tglRaw, pengisi, ...temaParts] = body.split("|").map((s) => s.trim());
    const tema = temaParts.join("|").trim();
    const tglMatch = tglRaw && tglRaw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!tglMatch || !pengisi || !tema) {
      reply = "Format: /kajian_tambah DD-MM-YYYY | Nama Pengisi | Tema\nContoh: /kajian_tambah 28-08-2026 | Ust. Fulan | Fiqih Puasa Sunnah";
      mutated = false;
    } else {
      const [, dd, mm, yyyy] = tglMatch;
      const tanggal = `${yyyy}-${mm}-${dd}`;
      const id = Date.now();
      const kajianBaru = { id, tanggal, pengisi, tema, remindersSent: [] };
      kajianBaru.googleEventId = await syncKajianToCalendar(env, kajianBaru, data);
      data.kajian.push(kajianBaru);
      data.kajian.sort((a, b) => a.tanggal.localeCompare(b.tanggal));

      const infoReminder = (data.kajianSettings.time && data.kajianSettings.offsetsDays.length > 0)
        ? `⏰ Diingatkan H-${data.kajianSettings.offsetsDays.join(", H-")} jam ${data.kajianSettings.time} WIB`
        : "⚠️ Pengingat BELUM diatur (kosong) -- atur dulu dengan /kajian_reminder supaya reminder ini benar-benar terkirim.";
      const infoCalendar = googleCalendarReady(env)
        ? (kajianBaru.googleEventId ? "🗓️ Tersinkron ke Google Calendar." : "⚠️ Belum disinkron ke Google Calendar karena jam acara belum diatur -- isi dulu dengan /kajian_jam.")
        : "";
      reply = `✅ Kajian ditambahkan:\n📅 ${dd}-${mm}-${yyyy}\n👤 ${pengisi}\n📖 ${tema}\n${infoReminder}` + (infoCalendar ? `\n${infoCalendar}` : "");
    }
  } else if (text.startsWith("/kajian_list")) {
    mutated = false;
    const today = jakartaDateStr(nowInJakarta());
    const upcoming = data.kajian.filter((k) => k.tanggal >= today);
    reply = upcoming.length
      ? "📚 <b>Jadwal Kajian Mendatang</b>\n\n" +
        upcoming.map((k, i) => `${i + 1}. 📅 ${fmtTanggalID(k.tanggal)}\n   👤 ${k.pengisi}\n   📖 ${k.tema}`).join("\n\n")
      : "Belum ada jadwal kajian mendatang. Tambah dengan /kajian_tambah.";
  } else if (text.startsWith("/kajian_hapus")) {
    const today = jakartaDateStr(nowInJakarta());
    const upcoming = data.kajian.filter((k) => k.tanggal >= today);
    const idx = parseInt(text.split(" ")[1], 10);
    if (!idx || idx < 1 || idx > upcoming.length) {
      reply = "Format: /kajian_hapus <nomor>\nLihat nomornya lewat /kajian_list dulu.";
      mutated = false;
    } else {
      const target = upcoming[idx - 1];
      if (target.googleEventId) await deleteGoogleCalendarEvent(env, target.googleEventId);
      data.kajian = data.kajian.filter((k) => k.id !== target.id);
      reply = `🗑️ Kajian "${target.tema}" (${fmtTanggalID(target.tanggal)}) dihapus.`;
    }
  } else if (text.startsWith("/kajian_reminder")) {
    // Format: /kajian_reminder <hari1,hari2,...> <jam:menit>
    // Contoh: /kajian_reminder 7,0 06:00  -> ingatkan H-7 & hari-H, jam 06:00 WIB
    const parts = text.split(" ").slice(1);
    const timeToken = parts.find((p) => /^\d{1,2}:\d{2}$/.test(p));
    const daysToken = parts.find((p) => /^\d+(,\d+)*$/.test(p));
    if (!timeToken || !daysToken) {
      reply = "Format: /kajian_reminder <hari...> <jam:menit>\nContoh: /kajian_reminder 7,0 06:00\n(artinya diingatkan H-7 dan hari-H, jam 06:00 WIB)";
      mutated = false;
    } else {
      data.kajianSettings.offsetsDays = [...new Set(daysToken.split(",").map((n) => parseInt(n, 10)))].sort((a, b) => b - a);
      data.kajianSettings.time = timeToken;
      reply = `✅ Kajian akan diingatkan H-${data.kajianSettings.offsetsDays.join(", H-")} jam ${data.kajianSettings.time} WIB.\nBerlaku untuk kajian yang ditambahkan setelah ini maupun yang sudah ada.`;
    }
  } else if (text.startsWith("/kajian_jam")) {
    const jam = text.split(" ")[1];
    if (!jam || !/^\d{1,2}:\d{2}$/.test(jam)) {
      reply = "Format: /kajian_jam <HH:MM>\nContoh: /kajian_jam 08:00\n(jam mulai acara sesungguhnya -- ikut muncul di teks reminder & sinkron Google Calendar)";
      mutated = false;
    } else {
      data.kajianSettings.jamAcara = jam;
      reply = `✅ Jam kajian diset ke ${jam} WIB.`;
    }
  } else if (text.startsWith("/kajian_lokasi")) {
    const lokasi = text.replace("/kajian_lokasi", "").trim();
    data.kajianSettings.lokasi = lokasi;
    reply = lokasi ? `✅ Lokasi kajian diset: "${lokasi}".` : "✅ Lokasi kajian dikosongkan (tidak akan muncul di reminder).";
  } else if (text.startsWith("/kajian_catatan")) {
    const catatan = text.replace("/kajian_catatan", "").trim();
    data.kajianSettings.catatan = catatan;
    reply = catatan ? `✅ Catatan tambahan diset, akan muncul di SETIAP reminder kajian:\n\nℹ️ ${catatan}` : "✅ Catatan tambahan dikosongkan.";
  } else if (text.startsWith("/kalender_reminder")) {
    const menit = parseInt(text.split(" ")[1], 10);
    if (isNaN(menit) || menit < 0) {
      reply = "Format: /kalender_reminder <menit>\nContoh: /kalender_reminder 15  (diingatkan 15 menit sebelum event Google Calendar mulai)";
      mutated = false;
    } else {
      data.calendarReminderMinutes = menit;
      reply = `✅ Event Google Calendar akan diingatkan ${menit} menit sebelum mulai.`;
    }
  } else if (text.startsWith("/ingat_tambah")) {
    const body = text.replace("/ingat_tambah", "").trim();
    const [topikKey, judul, pesan, jadwalStr] = body.split("|").map((s) => (s || "").trim());
    const schedule = jadwalStr && parseJadwalUmum(jadwalStr);
    if (!topikKey || !judul || !pesan || !schedule) {
      reply =
        "Format: /ingat_tambah <topik> | <judul> | <pesan> | <jadwal>\n\n" +
        "Jadwal:\n• sekali DD-MM-YYYY HH:MM\n• harian HH:MM\n• mingguan <hari,hari> HH:MM\n• bulanan <tanggal 1-31> HH:MM\n\n" +
        "Contoh: /ingat_tambah umum | Rapat Bulanan | Jangan lupa rapat evaluasi | bulanan 1 09:00";
      mutated = false;
    } else if (!data.topics[topikKey]) {
      reply = `Topik "${topikKey}" belum terdaftar. Cek nama yang benar lewat /topik_daftar, atau daftarkan dulu dgn /topik_set di dalam topik itu.`;
      mutated = false;
    } else {
      const reminderBaru = { id: Date.now(), title: judul, message: pesan, topicKey, schedule, enabled: true, lastSentDate: null };
      reminderBaru.googleEventId = await syncReminderToCalendar(env, reminderBaru);
      data.reminders = data.reminders || [];
      data.reminders.push(reminderBaru);
      reply = `✅ Pengingat "${judul}" dijadwalkan (${formatJadwalUmum(schedule)}) ke topik "${topikKey}".` +
        (reminderBaru.googleEventId ? "\n🗓️ Tersinkron ke Google Calendar." : "");
    }
  } else if (text.startsWith("/ingat_list")) {
    mutated = false;
    const list = data.reminders || [];
    reply = list.length
      ? "🔔 <b>Pengingat Umum</b>\n\n" + list.map((r, i) => `${i + 1}. ${r.enabled ? "✅" : "⏸️"} <b>${r.title}</b>\n   ${formatJadwalUmum(r.schedule)} → #${r.topicKey}`).join("\n\n")
      : "Belum ada pengingat umum. Tambah dengan /ingat_tambah.";
  } else if (text.startsWith("/ingat_hapus")) {
    const idx = parseInt(text.split(" ")[1], 10);
    const list = data.reminders || [];
    if (!idx || idx < 1 || idx > list.length) {
      reply = "Format: /ingat_hapus <nomor>\nLihat nomornya lewat /ingat_list dulu.";
      mutated = false;
    } else {
      const target = list[idx - 1];
      if (target.googleEventId) await deleteGoogleCalendarEvent(env, target.googleEventId);
      data.reminders = list.filter((r) => r.id !== target.id);
      reply = `🗑️ Pengingat "${target.title}" dihapus.`;
    }
  } else if (text.startsWith("/ingat_on") || text.startsWith("/ingat_off")) {
    const enable = text.startsWith("/ingat_on");
    const idx = parseInt(text.split(" ")[1], 10);
    const list = data.reminders || [];
    if (!idx || idx < 1 || idx > list.length) {
      reply = `Format: /${enable ? "ingat_on" : "ingat_off"} <nomor>\nLihat nomornya lewat /ingat_list dulu.`;
      mutated = false;
    } else {
      list[idx - 1].enabled = enable;
      reply = `${enable ? "▶️ Diaktifkan" : "⏸️ Dinonaktifkan"}: "${list[idx - 1].title}"`;
    }
  } else if (text.startsWith("/id")) {
    mutated = false;
    const nama = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || msg.from.username || "-";
    reply = `🆔 ID Telegram Anda: <code>${msg.from.id}</code>\nNama: ${nama}\n\nKirim ID ini ke admin kalau perlu diberi akses lewat /admin_tambah.`;
  } else if (text.startsWith("/admin_daftar")) {
    mutated = false;
    reply = data.adminUserIds.length
      ? "👮 <b>Admin terdaftar</b>\n\n" + data.adminUserIds.map((id) => `• <code>${id}</code>`).join("\n") +
        "\n\nHanya ID di atas yang bisa pakai perintah pengaturan (topik/jadwal/kajian/dst)."
      : "Belum ada admin terdaftar — SEMUA anggota grup masih bisa pakai semua perintah.\nTambahkan admin pertama (diri Anda sendiri) dengan: /admin_tambah";
  } else if (text.startsWith("/admin_tambah")) {
    // tanpa argumen -> tambah ID pengirim sendiri (buat bootstrap admin pertama)
    const targetId = parseInt(text.split(/\s+/)[1], 10) || msg.from.id;
    if (data.adminUserIds.includes(targetId)) {
      reply = `ID <code>${targetId}</code> sudah jadi admin.`;
      mutated = false;
    } else {
      data.adminUserIds.push(targetId);
      reply = `✅ ID <code>${targetId}</code> ditambahkan sebagai admin.` +
        (data.adminUserIds.length === 1 ? "\n\n⚠️ Mulai sekarang perintah pengaturan (topik/jadwal/kajian/dst) HANYA bisa dipakai admin terdaftar. Tambahkan admin lain kalau perlu." : "");
    }
  } else if (text.startsWith("/admin_hapus")) {
    const targetId = parseInt(text.split(/\s+/)[1], 10);
    if (!targetId) {
      reply = "Format: /admin_hapus <user_id>\nLihat ID-nya lewat /admin_daftar.";
      mutated = false;
    } else if (!data.adminUserIds.includes(targetId)) {
      reply = `ID <code>${targetId}</code> bukan admin terdaftar.`;
      mutated = false;
    } else {
      data.adminUserIds = data.adminUserIds.filter((id) => id !== targetId);
      reply = `🗑️ ID <code>${targetId}</code> dihapus dari daftar admin.` +
        (data.adminUserIds.length === 0 ? "\n\n⚠️ Daftar admin sekarang kosong — SEMUA anggota grup bisa pakai semua perintah lagi." : "");
    }
  } else if (text.startsWith("/tanya")) {
    mutated = false;
    const pertanyaan = text.replace("/tanya", "").trim();
    if (!pertanyaan) {
      reply = "Format: /tanya <pertanyaan>\nContoh: /tanya apa hukum puasa sunnah senin kamis?";
    } else {
      const jawaban = await callAiTextDual(
        env,
        "Kamu asisten komunitas muslim yang sopan dan hati-hati. Jawab singkat (maks 4-5 kalimat) Bahasa Indonesia. Untuk pertanyaan fiqih/hukum agama yang spesifik, beri jawaban umum yang hati-hati dan SELALU sarankan konfirmasi ke ustadz/pengurus masjid setempat untuk kepastian -- jangan berlagak jadi otoritas fatwa. Untuk pertanyaan umum non-agama, jawab biasa & membantu.",
        pertanyaan,
        280
      );
      reply = jawaban || "⚠️ AI sedang tidak tersedia (belum dikonfigurasi atau kuota harian habis). Coba lagi nanti, atau cek /kuota.";
    }
  } else if (text.startsWith("/puasa_insight")) {
    mutated = false;
    const key = jakartaDateStr(nowInJakarta());
    const log = data.puasaLog[key];
    if (!log || Object.keys(log.answers || {}).length === 0) {
      reply = "Belum ada data jawaban puasa hari ini untuk dianalisis AI.";
    } else {
      const puasa = Object.values(log.answers).filter((a) => a.choice === 0).length;
      const tidak = Object.values(log.answers).filter((a) => a.choice === 1).length;
      const ringkasan = `Hari ini (${key}): ${puasa} orang puasa, ${tidak} orang tidak puasa, dari total ${puasa + tidak} yang menjawab poll.`;
      const insight = await callAiTextDual(
        env,
        "Kamu asisten komunitas muslim yang suportif. Berdasarkan angka rekap puasa berikut, tulis catatan singkat 2-3 kalimat Bahasa Indonesia yang menyemangati komunitas -- HANYA pakai angka yang diberikan, jangan mengarang. Nada hangat, bukan menghakimi yang tidak puasa (banyak alasan syar'i utk tidak puasa).",
        ringkasan,
        180
      );
      reply = insight ? "🌙 <b>Catatan AI</b>\n\n" + insight : ringkasan + "\n\n(AI sedang tidak tersedia untuk catatan tambahan.)";
    }
  } else if (text.startsWith("/kuota")) {
    mutated = false;
    reply = buildAiQuotaMessage(await getAiQuotaStatus(env));
  } else if (text.startsWith("/help")) {
    mutated = false;
    reply =
      "<b>Perintah bot komunitas</b>\n\n" +
      "💬 <i>Semua command bisa TANPA \"/\" juga (mis. ketik langsung \"topik_daftar\"). Bisa juga kalimat bebas kalau DM ke bot, reply pesan bot, atau mention bot -- mis. \"tolong jadwalin kajian tanggal 5 september jam 8 malam sama ust fulan temanya sedekah\".</i>\n\n" +
      "🗂️ <b>Topik</b>\n/topik_set &lt;nama&gt; — daftarkan topik ini\n/topik_hapus &lt;nama&gt;\n/topik_daftar\n\n" +
      "🌙 <b>Absensi Puasa</b>\n/puasa_jadwal &lt;hari...&gt; &lt;jam:menit&gt;\n/puasa_pertanyaan &lt;teks&gt;\n/puasa_opsi &lt;opsi1&gt; | &lt;opsi2&gt;\n/puasa_off\n/puasa_sekarang\n/puasa_rekap\n\n" +
      "📚 <b>Kajian</b>\n/kajian_tambah DD-MM-YYYY | Pengisi | Tema\n/kajian_list\n/kajian_hapus &lt;nomor&gt;\n/kajian_reminder &lt;hari,hari&gt; &lt;jam:menit&gt;\n/kajian_jam &lt;HH:MM&gt;\n/kajian_lokasi &lt;teks&gt;\n/kajian_catatan &lt;teks&gt;\n\n" +
      "🔔 <b>Pengingat Umum</b>\n/ingat_tambah &lt;topik&gt; | &lt;judul&gt; | &lt;pesan&gt; | &lt;jadwal&gt;\n  jadwal: sekali DD-MM-YYYY HH:MM / harian HH:MM / mingguan hari,hari HH:MM / bulanan tanggal HH:MM\n/ingat_list\n/ingat_hapus &lt;nomor&gt;\n/ingat_on, /ingat_off &lt;nomor&gt;\n\n" +
      "🗓️ <b>Google Calendar</b>\n/kalender_reminder &lt;menit&gt;\n(kajian &amp; pengingat umum otomatis tersinkron ke Calendar kalau ENV Google sudah diisi)\n\n" +
      "👮 <b>Admin</b>\n/id — lihat ID Telegram Anda\n/admin_daftar\n/admin_tambah [user_id] — tanpa argumen = tambah diri sendiri\n/admin_hapus &lt;user_id&gt;\n(command pengaturan spt topik/jadwal/kajian/ingat cuma bisa dipakai admin terdaftar, kalau daftar admin sudah diisi)\n\n" +
      "🤖 <b>AI</b>\n/tanya &lt;pertanyaan&gt; — tanya bebas ke AI\n/puasa_insight — catatan AI dari rekap puasa hari ini\n/kuota — cek pemakaian kuota AI";
  }

  if (reply) await sendMessage(env, reply, threadId);
  if (mutated) {
    try {
      await githubPutFile(env, data, sha);
    } catch (e) {
      await sendMessage(env, "⚠️ Perintah diterima tapi gagal menyimpan ke database: " + String(e.message || e), threadId);
    }
  }
  return json({ ok: true });
}

async function handlePollAnswer(env, pollAnswer) {
  const { data, sha } = await githubGetFile(env);
  // cari log hari mana yang punya poll_id ini (biasanya hari ini, tapi
  // dicek semua entry 2 hari terakhir buat jaga2 jawaban telat)
  let matchedKey = null;
  for (const key of Object.keys(data.puasaLog)) {
    if (data.puasaLog[key].pollId === pollAnswer.poll_id) {
      matchedKey = key;
      break;
    }
  }
  if (!matchedKey) return; // poll ini bukan poll puasa yang kita lacak
  const name = [pollAnswer.user.first_name, pollAnswer.user.last_name].filter(Boolean).join(" ") || pollAnswer.user.username || "Tanpa nama";
  if (pollAnswer.option_ids.length === 0) {
    // user membatalkan jawabannya
    delete data.puasaLog[matchedKey].answers[pollAnswer.user.id];
  } else {
    data.puasaLog[matchedKey].answers[pollAnswer.user.id] = { name, choice: pollAnswer.option_ids[0] };
  }
  await githubPutFile(env, data, sha);
}

function fmtTanggalID(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const bulan = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
  return `${d} ${bulan[m - 1]} ${y}`;
}

/* ---------------- Pengingat umum: parsing & format jadwal ----------------
   Format teks bebas yang diterima command /ingat_tambah:
     sekali DD-MM-YYYY HH:MM
     harian HH:MM
     mingguan <hari,hari,...> HH:MM
     bulanan <tanggal 1-31> HH:MM      */
function parseJadwalUmum(str) {
  const parts = (str || "").trim().split(/\s+/);
  const kind = (parts[0] || "").toLowerCase();
  if (kind === "sekali") {
    const m = parts[1] && parts[1].match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m || !/^\d{1,2}:\d{2}$/.test(parts[2] || "")) return null;
    const [, dd, mm, yyyy] = m;
    return { type: "once", date: `${yyyy}-${mm}-${dd}`, time: parts[2] };
  }
  if (kind === "harian") {
    if (!/^\d{1,2}:\d{2}$/.test(parts[1] || "")) return null;
    return { type: "daily", time: parts[1] };
  }
  if (kind === "mingguan") {
    if (!parts[1] || !/^\d{1,2}:\d{2}$/.test(parts[2] || "")) return null;
    const days = parts[1].split(",").map((d) => HARI_MAP[d.toLowerCase()]).filter((d) => d !== undefined);
    if (!days.length) return null;
    return { type: "weekly", time: parts[2], daysOfWeek: [...new Set(days)] };
  }
  if (kind === "bulanan") {
    const dom = parseInt(parts[1], 10);
    if (!dom || dom < 1 || dom > 31 || !/^\d{1,2}:\d{2}$/.test(parts[2] || "")) return null;
    return { type: "monthly", time: parts[2], dayOfMonth: dom };
  }
  return null;
}
function formatJadwalUmum(s) {
  if (s.type === "once") { const [y, m, d] = s.date.split("-"); return `sekali, ${d}-${m}-${y} jam ${s.time}`; }
  if (s.type === "daily") return `harian jam ${s.time}`;
  if (s.type === "weekly") return `tiap ${s.daysOfWeek.map((d) => HARI_LABEL[d]).join(", ")} jam ${s.time}`;
  if (s.type === "monthly") return `tanggal ${s.dayOfMonth} tiap bulan jam ${s.time}`;
  return "-";
}

/* ---------------- Cron: cek tiap jam ---------------- */
async function handleScheduledTick(env) {
  const { data, sha } = await githubGetFile(env);
  const jkt = nowInJakarta();
  const todayKey = jakartaDateStr(jkt);
  const hh = String(jkt.getUTCHours()).padStart(2, "0");
  const mm = String(jkt.getUTCMinutes()).padStart(2, "0");
  const nowHM = `${hh}:${mm}`;
  const dow = jkt.getUTCDay();
  let mutated = false;

  // ---------- polling puasa ----------
  // Butuh SEMUA dari ini terisi manual dulu: enabled, hari, jam, pertanyaan,
  // & 2 opsi -- kalau ada yang belum diisi, blok ini dilewati diam-diam
  // (bukan diam-diam kirim pakai nilai bawaan spt versi lama).
  if (
    data.puasaPoll.enabled &&
    data.puasaPoll.time &&
    data.puasaPoll.days.length > 0 &&
    data.puasaPoll.question &&
    data.puasaPoll.options.length >= 2
  ) {
    // cron jalan tiap 5 menit, jadi cocokkan JAM saja (menit diabaikan)
    // supaya /puasa_jadwal cukup pakai menit :00.
    const scheduledHour = data.puasaPoll.time.split(":")[0];
    if (data.puasaPoll.days.includes(dow) && scheduledHour === hh && data.lastPuasaPollSentDate !== todayKey) {
      const tid = threadIdOf(data, "puasa");
      const res = await sendPoll(env, data.puasaPoll.question, data.puasaPoll.options, tid);
      if (res.ok) {
        data.puasaLog[todayKey] = { pollId: res.result.poll.id, threadId: tid, answers: {} };
        data.lastPuasaPollSentDate = todayKey;
        mutated = true;
      }
    }
  }

  // ---------- reminder kajian ----------
  // Dicek TIAP JAM (bukan cuma 1x/hari) supaya bisa cocok persis dengan
  // JAM yang diatur di kajianSettings.time. WAJIB diisi manual dulu lewat
  // /kajian_reminder -- kalau time/offsetsDays belum diisi, blok ini
  // dilewati (tidak ada reminder kajian yang terkirim sama sekali).
  // tiap offset+kajian ditandai di remindersSent begitu terkirim, aman
  // dicek berkali-kali per hari -- tidak akan dobel kirim.
  if (data.kajianSettings.time && data.kajianSettings.offsetsDays.length > 0) {
    const tid = threadIdOf(data, "kajian");
    const settingsHour = data.kajianSettings.time.split(":")[0];
    if (settingsHour === hh) {
      for (const k of data.kajian) {
        const daysUntil = Math.round((new Date(k.tanggal) - new Date(todayKey)) / 86400000);
        k.remindersSent = k.remindersSent || [];
        if (data.kajianSettings.offsetsDays.includes(daysUntil) && !k.remindersSent.includes(daysUntil)) {
          const judul = daysUntil === 0 ? "📚 <b>Kajian HARI INI</b>" : `📚 <b>Pengingat Kajian (H-${daysUntil})</b>`;
          const jam = data.kajianSettings.jamAcara;
          const lokasi = data.kajianSettings.lokasi;
          const catatan = data.kajianSettings.catatan;
          const teks =
            `${judul}\n\n` +
            `📅 ${fmtTanggalID(k.tanggal)}${daysUntil > 0 ? ` — ${daysUntil} hari lagi` : ""}` +
            (jam ? ` jam ${jam} WIB` : "") + "\n" +
            (lokasi ? `📍 ${lokasi}\n` : "") +
            `👤 ${k.pengisi}\n📖 ${k.tema}` +
            (catatan ? `\n\nℹ️ ${catatan}` : "");
          await sendMessage(env, teks, tid);
          k.remindersSent.push(daysUntil);
          mutated = true;
        }
      }
    }
  }

  // ---------- beres-beres harian (sekali per hari cukup) ----------
  if (data.lastKajianCheckDate !== todayKey) {
    // buang kajian yang sudah lewat >7 hari biar data tidak menumpuk terus
    const cutoff = jakartaDateStr(new Date(jkt.getTime() - 7 * 86400000));
    const before = data.kajian.length;
    data.kajian = data.kajian.filter((k) => k.tanggal >= cutoff);
    if (data.kajian.length !== before) mutated = true;

    data.lastKajianCheckDate = todayKey;
    mutated = true;
  }

  // ---------- pengingat umum (custom) ----------
  // Dicek tiap tick (5 menit). Waktu dicocokkan per-bucket 5 menit (bukan
  // harus persis sama detik), dan "lastSentDate" mencegah dobel kirim
  // dalam hari yang sama -- berlaku sama utk semua tipe jadwal.
  {
    const nowMin = jkt.getUTCHours() * 60 + jkt.getUTCMinutes();
    for (const r of data.reminders || []) {
      if (!r.enabled) continue;
      if (r.lastSentDate === todayKey) continue;
      const [th, tm] = r.schedule.time.split(":").map(Number);
      const schedMin = th * 60 + tm;
      if (Math.floor(nowMin / TICK_INTERVAL_MIN) !== Math.floor(schedMin / TICK_INTERVAL_MIN)) continue;

      let cocok = false;
      if (r.schedule.type === "once") cocok = r.schedule.date === todayKey;
      else if (r.schedule.type === "daily") cocok = true;
      else if (r.schedule.type === "weekly") cocok = (r.schedule.daysOfWeek || []).includes(dow);
      else if (r.schedule.type === "monthly") cocok = jkt.getUTCDate() === r.schedule.dayOfMonth;
      if (!cocok) continue;

      const tid = threadIdOf(data, r.topicKey);
      await sendMessage(env, `🔔 <b>${r.title}</b>\n\n${r.message}`, tid);
      r.lastSentDate = todayKey;
      if (r.schedule.type === "once") r.enabled = false; // sekali jadi, tidak perlu jalan lagi
      mutated = true;
    }
  }

  // ---------- beres2 puasaLog lama (simpan 14 hari terakhir saja) ----------
  const logCutoff = jakartaDateStr(new Date(jkt.getTime() - 14 * 86400000));
  for (const key of Object.keys(data.puasaLog)) {
    if (key < logCutoff) {
      delete data.puasaLog[key];
      mutated = true;
    }
  }

  // ---------- pengingat Google Calendar ----------
  // WAJIB cron jalan tiap 5 menit (bukan tiap jam) supaya pengingat
  // "sekian menit sebelum mulai" presisi -- lihat TICK_INTERVAL_MIN.
  // Kalau ENV Google ATAU calendarReminderMinutes belum diisi manual
  // (lewat /kalender_reminder), bagian ini dilewati diam-diam (fitur
  // lain tetap jalan normal, tidak ada nilai bawaan yang dipakai).
  if (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && env.GOOGLE_CALENDAR_ID && data.calendarReminderMinutes != null) {
    try {
      const events = await fetchUpcomingCalendarEvents(env);
      const tid = threadIdOf(data, "kalender");
      const reminderMin = data.calendarReminderMinutes;
      const nowReal = new Date(); // pakai waktu absolut asli (BUKAN jkt yg sudah digeser +7) buat dibandingkan ke timestamp event dari Google yg juga absolut
      data.calendarRemindedIds = data.calendarRemindedIds || [];
      for (const ev of events) {
        if (!ev.start || !ev.start.dateTime) continue; // lewati event "sepanjang hari" -- tidak ada jam pasti utk pengingat per-menit
        if (data.calendarRemindedIds.includes(ev.id)) continue;
        const start = new Date(ev.start.dateTime);
        const minutesUntil = (start.getTime() - nowReal.getTime()) / 60000;
        // jendela selebar TICK_INTERVAL_MIN supaya tidak "kelewat" walau
        // cron sempat telat beberapa puluh detik
        if (minutesUntil <= reminderMin && minutesUntil > reminderMin - TICK_INTERVAL_MIN) {
          const jamWIB = new Date(start.getTime() + 7 * 3600000).toISOString().substring(11, 16);
          const teks =
            `🗓️ <b>${ev.summary || "(Tanpa judul)"}</b>\n` +
            `⏰ Mulai jam ${jamWIB} WIB (${Math.max(0, Math.round(minutesUntil))} menit lagi)` +
            (ev.location ? `\n📍 ${ev.location}` : "") +
            (ev.description ? `\n\n${ev.description.slice(0, 300)}` : "");
          await sendMessage(env, teks, tid);
          data.calendarRemindedIds.push(ev.id);
          mutated = true;
        }
      }
      // biar tidak menumpuk selamanya
      if (data.calendarRemindedIds.length > 500) {
        data.calendarRemindedIds = data.calendarRemindedIds.slice(-300);
        mutated = true;
      }
    } catch (e) {
      console.log("Gagal cek Google Calendar:", (e && e.stack) || e);
    }
  }

  if (mutated) await githubPutFile(env, data, sha);
}

/* ---------------- Entry point Worker ---------------- */
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return json({ ok: true });

      if (url.pathname === "/data" && request.method === "GET") {
        if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
        const { data, sha } = await githubGetFile(env);
        return json({ data, sha });
      }

      if (url.pathname === "/data" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
        const body = await request.json();
        const { sha: currentSha } = await githubGetFile(env);
        if (body.sha !== undefined && body.sha !== currentSha) {
          return json({ error: "CONFLICT", message: "Data sudah berubah sejak terakhir dimuat. Muat ulang dulu." }, 409);
        }
        const putResult = await githubPutFile(env, body.data, currentSha);
        return json({ ok: true, sha: putResult?.content?.sha || null });
      }

      if (url.pathname === "/telegram-webhook" && request.method === "POST") {
        return handleTelegramWebhook(request, env);
      }

      if (url.pathname === "/ai-quota" && request.method === "GET") {
        if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
        return json(await getAiQuotaStatus(env));
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.log("fetch handler error:", (e && e.stack) || e);
      return json({ error: "Worker error", detail: String((e && e.message) || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledTick(env).catch((e) => console.log("handleScheduledTick error:", (e && e.stack) || e)));
  },
};
