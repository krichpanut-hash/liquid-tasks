/* =========================================================
   /api/tasks
   GET            → รายการงานทั้งหมด
   POST           → สร้างงาน (ออบเจกต์เดียวหรืออาร์เรย์) ถ้ามี id ซ้ำจะอัปเดตแทน (ใช้ตอนเลิกทำ)
   DELETE ?done=true → ลบงานที่เสร็จแล้วทั้งหมด
   ทุกคนใช้รายการงานชุดเดียวกัน
   ========================================================= */
import {
  SHARED_BOARD_ID,
  TASK_COLUMNS,
  HttpError,
  ensureSchema,
  getSql,
  handleError,
  hasDatabase,
  readBody,
  rowToTask,
  sanitizeTask,
  sendJson,
} from './_lib/db.js';

const MAX_BULK = 200;

export default async function handler(req, res) {
  try {
    if (!hasDatabase()) throw new HttpError(503, 'ยังไม่ได้ตั้งค่าฐานข้อมูล (DATABASE_URL)');

    const boardId = SHARED_BOARD_ID;

    await ensureSchema();
    const sql = getSql();

    switch (req.method) {
      case 'GET': {
        const rows = await sql.query(
          `SELECT ${TASK_COLUMNS} FROM tasks WHERE board_id = $1 ORDER BY created_at DESC`,
          [boardId]
        );
        return sendJson(res, 200, { tasks: rows.map(rowToTask) });
      }

      case 'POST': {
        const body = readBody(req);
        if (body === undefined) throw new HttpError(400, 'JSON ไม่ถูกต้อง');
        const items = Array.isArray(body) ? body : [body];
        if (items.length === 0) throw new HttpError(400, 'ไม่มีข้อมูลงาน');
        if (items.length > MAX_BULK) throw new HttpError(400, `ส่งได้ครั้งละไม่เกิน ${MAX_BULK} รายการ`);

        const clean = items.map((item) => sanitizeTask(item));
        const saved = [];
        for (const task of clean) {
          const id = task.id || crypto.randomUUID();
          const createdAt = task.createdAt || new Date().toISOString();
          const completedAt = task.done ? task.completedAt || new Date().toISOString() : null;
          const rows = await sql.query(
            `INSERT INTO tasks (id, board_id, title, note, priority, due, done, created_at, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               title = EXCLUDED.title,
               note = EXCLUDED.note,
               priority = EXCLUDED.priority,
               due = EXCLUDED.due,
               done = EXCLUDED.done,
               completed_at = EXCLUDED.completed_at,
               updated_at = now()
             WHERE tasks.board_id = EXCLUDED.board_id
             RETURNING ${TASK_COLUMNS}`,
            [id, boardId, task.title, task.note, task.priority, task.due, task.done, createdAt, completedAt]
          );
          if (rows.length === 0) throw new HttpError(409, 'รหัสงานนี้ถูกใช้แล้ว');
          saved.push(rowToTask(rows[0]));
        }
        return sendJson(res, 201, { tasks: saved });
      }

      case 'DELETE': {
        if (req.query?.done !== 'true') {
          throw new HttpError(400, 'ระบุ ?done=true เพื่อลบงานที่เสร็จแล้ว หรือใช้ /api/tasks/:id');
        }
        const rows = await sql.query(
          'DELETE FROM tasks WHERE board_id = $1 AND done = TRUE RETURNING id',
          [boardId]
        );
        return sendJson(res, 200, { deleted: rows.length });
      }

      default:
        res.setHeader('Allow', 'GET, POST, DELETE');
        throw new HttpError(405, 'ไม่รองรับเมธอดนี้');
    }
  } catch (err) {
    handleError(res, err);
  }
}
