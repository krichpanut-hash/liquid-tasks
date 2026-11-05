/* =========================================================
   /api/tasks/:id
   PATCH  → แก้ไขบางฟิลด์ของงาน (title, note, priority, due, done)
   DELETE → ลบงาน
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
} from '../_lib/db.js';

const TASK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export default async function handler(req, res) {
  try {
    if (!hasDatabase()) throw new HttpError(503, 'ยังไม่ได้ตั้งค่าฐานข้อมูล (DATABASE_URL)');

    const boardId = SHARED_BOARD_ID;

    const id = typeof req.query?.id === 'string' ? req.query.id : '';
    if (!TASK_ID_RE.test(id)) throw new HttpError(400, 'รหัสงานไม่ถูกต้อง');

    await ensureSchema();
    const sql = getSql();

    switch (req.method) {
      case 'PATCH':
      case 'PUT': {
        const body = readBody(req);
        if (body === undefined) throw new HttpError(400, 'JSON ไม่ถูกต้อง');
        const patch = sanitizeTask(body, { partial: true });

        const sets = [];
        const params = [];
        const add = (column, value) => {
          params.push(value);
          sets.push(`${column} = $${params.length}`);
        };
        if ('title' in patch) add('title', patch.title);
        if ('note' in patch) add('note', patch.note);
        if ('priority' in patch) add('priority', patch.priority);
        if ('due' in patch) add('due', patch.due);
        if ('done' in patch) {
          add('done', patch.done);
          // เมื่อเปลี่ยนสถานะเสร็จ ให้บันทึกเวลาเสร็จ / ล้างเวลาเสร็จอัตโนมัติ
          add('completed_at', patch.done ? patch.completedAt || new Date().toISOString() : null);
        } else if ('completedAt' in patch) {
          add('completed_at', patch.completedAt);
        }
        if (sets.length === 0) throw new HttpError(400, 'ไม่มีฟิลด์ที่ต้องการแก้ไข');
        sets.push('updated_at = now()');

        params.push(id, boardId);
        const rows = await sql.query(
          `UPDATE tasks SET ${sets.join(', ')}
           WHERE id = $${params.length - 1} AND board_id = $${params.length}
           RETURNING ${TASK_COLUMNS}`,
          params
        );
        if (rows.length === 0) throw new HttpError(404, 'ไม่พบงานนี้');
        return sendJson(res, 200, { task: rowToTask(rows[0]) });
      }

      case 'DELETE': {
        const rows = await sql.query(
          'DELETE FROM tasks WHERE id = $1 AND board_id = $2 RETURNING id',
          [id, boardId]
        );
        if (rows.length === 0) throw new HttpError(404, 'ไม่พบงานนี้');
        return sendJson(res, 200, { deleted: 1 });
      }

      default:
        res.setHeader('Allow', 'PATCH, PUT, DELETE');
        throw new HttpError(405, 'ไม่รองรับเมธอดนี้');
    }
  } catch (err) {
    handleError(res, err);
  }
}
