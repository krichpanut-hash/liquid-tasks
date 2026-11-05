/* =========================================================
   ตัวช่วยสำหรับ API: เชื่อมต่อ Neon Postgres, สคีมา, ตรวจสอบข้อมูล
   (ไฟล์ในโฟลเดอร์ _lib จะไม่ถูก Vercel มองว่าเป็น endpoint)
   ========================================================= */
import { neon } from '@neondatabase/serverless';

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

/** ทุกคนใช้รายการงานชุดเดียวกัน (ไม่มีการแยกผู้ใช้) */
export const SHARED_BOARD_ID = 'shared';

const TASK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const TASK_COLUMNS =
  'id, board_id, title, note, priority, due::text AS due, done, created_at, completed_at';

let sqlClient = null;
let schemaReady = null;

export function hasDatabase() {
  return Boolean(CONNECTION_STRING);
}

export function getSql() {
  if (!sqlClient) sqlClient = neon(CONNECTION_STRING);
  return sqlClient;
}

/** สร้างตารางอัตโนมัติถ้ายังไม่มี (รันครั้งเดียวต่ออินสแตนซ์ของฟังก์ชัน) */
export function ensureSchema() {
  if (!schemaReady) {
    const sql = getSql();
    schemaReady = (async () => {
      await sql.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id            TEXT PRIMARY KEY,
          board_id      TEXT NOT NULL,
          title         TEXT NOT NULL,
          note          TEXT NOT NULL DEFAULT '',
          priority      SMALLINT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
          due           DATE,
          done          BOOLEAN NOT NULL DEFAULT FALSE,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          completed_at  TIMESTAMPTZ,
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await sql.query(
        'CREATE INDEX IF NOT EXISTS tasks_board_created_idx ON tasks (board_id, created_at DESC)'
      );
    })().catch((err) => {
      schemaReady = null; // ให้ลองใหม่ในคำขอถัดไป
      throw err;
    });
  }
  return schemaReady;
}

/* ---------- HTTP helpers ---------- */
export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function readBody(req) {
  const body = req.body;
  if (body === undefined || body === null || body === '') return null;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return undefined; // JSON ไม่ถูกต้อง
    }
  }
  return body;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------- แปลงข้อมูล ---------- */
function toISO(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function rowToTask(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note ?? '',
    priority: Number(row.priority),
    due: row.due ? String(row.due).slice(0, 10) : '',
    done: Boolean(row.done),
    createdAt: toISO(row.created_at),
    completedAt: row.completed_at ? toISO(row.completed_at) : null,
  };
}

/* ---------- ตรวจสอบข้อมูลขาเข้า ---------- */
function isValidISODate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isValidTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

/**
 * ตรวจสอบและทำความสะอาดข้อมูลงาน
 * - partial = false: สำหรับสร้างใหม่ (ต้องมี title)
 * - partial = true : สำหรับแก้ไขบางฟิลด์ (ส่งเฉพาะฟิลด์ที่ต้องการเปลี่ยน)
 */
export function sanitizeTask(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'รูปแบบข้อมูลไม่ถูกต้อง');
  }
  const out = {};

  if ('title' in input || !partial) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new HttpError(400, 'กรุณากรอกชื่องาน');
    if (title.length > 120) throw new HttpError(400, 'ชื่องานยาวเกิน 120 ตัวอักษร');
    out.title = title;
  }

  if ('note' in input || !partial) {
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length > 500) throw new HttpError(400, 'รายละเอียดยาวเกิน 500 ตัวอักษร');
    out.note = note;
  }

  if ('priority' in input || !partial) {
    const priority = input.priority === undefined ? 3 : Number(input.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
      throw new HttpError(400, 'ระดับความสำคัญต้องอยู่ระหว่าง 1 ถึง 5');
    }
    out.priority = priority;
  }

  if ('due' in input || !partial) {
    const due = input.due === undefined || input.due === null ? '' : String(input.due);
    if (due && !isValidISODate(due)) throw new HttpError(400, 'รูปแบบวันที่กำหนดส่งไม่ถูกต้อง (YYYY-MM-DD)');
    out.due = due || null;
  }

  if ('done' in input || !partial) {
    out.done = Boolean(input.done);
  }

  // ฟิลด์เสริมสำหรับการกู้คืน (เลิกทำ) หรือย้ายข้อมูลจากเครื่อง
  if (typeof input.id === 'string' && input.id) {
    if (!TASK_ID_RE.test(input.id)) throw new HttpError(400, 'รหัสงานไม่ถูกต้อง');
    out.id = input.id;
  }
  if (isValidTimestamp(input.createdAt)) out.createdAt = new Date(input.createdAt).toISOString();
  if (input.completedAt === null) out.completedAt = null;
  else if (isValidTimestamp(input.completedAt)) out.completedAt = new Date(input.completedAt).toISOString();

  return out;
}

export function handleError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  console.error('[api/tasks]', err);
  sendJson(res, 500, { error: 'ฐานข้อมูลขัดข้อง กรุณาลองใหม่อีกครั้ง' });
}
