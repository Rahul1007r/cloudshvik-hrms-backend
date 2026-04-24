const db   = require('../config/db');
const path = require('path');
const fs   = require('fs');

const RESUME_DIR = process.env.RESUME_DIR || path.join(__dirname, '../../uploads/resumes');
if (!fs.existsSync(RESUME_DIR)) fs.mkdirSync(RESUME_DIR, { recursive: true });

// ── GET /api/recruitment/stats ────────────────────────────
const getStats = async (req, res) => {
  try {
    const [[jobs]] = await db.execute(`
      SELECT
        SUM(status='Open')     AS open_jobs,
        SUM(status='Draft')    AS draft_jobs,
        SUM(status='Closed')   AS closed_jobs,
        SUM(vacancies)         AS total_vacancies,
        COUNT(*)               AS total_jobs
      FROM job_openings`);

    const [[cands]] = await db.execute(`
      SELECT
        COUNT(*)                          AS total,
        SUM(stage='Applied')              AS applied,
        SUM(stage='Screening')            AS screening,
        SUM(stage IN ('Interview','Technical','HR Round')) AS interviewing,
        SUM(stage='Offer')                AS offered,
        SUM(stage='Hired')                AS hired,
        SUM(stage='Rejected')             AS rejected
      FROM candidates WHERE is_active = 1`);

    const [[upcoming]] = await db.execute(`
      SELECT COUNT(*) AS count FROM interviews
      WHERE scheduled_at >= NOW() AND status = 'Scheduled'`);

    res.json({ success: true, data: { jobs, cands, upcomingInterviews: upcoming.count } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

// ── GET /api/recruitment/jobs ─────────────────────────────
const getJobs = async (req, res) => {
  try {
    const { status, department_id, page = 1, limit = 12 } = req.query;
    const conditions = ['1=1']; const params = [];
    if (status)        { conditions.push('jo.status = ?');         params.push(status); }
    if (department_id) { conditions.push('jo.department_id = ?');  params.push(department_id); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page)-1)*Number(limit);
    const [[{total}]] = await db.execute(`SELECT COUNT(*) AS total FROM job_openings jo WHERE ${where}`, params);

    const [rows] = await db.execute(`
      SELECT jo.*,
             d.name  AS department_name,
             des.name AS designation_name,
             e.full_name AS hiring_manager_name,
             u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM candidates WHERE job_opening_id=jo.id AND is_active=1)     AS applicant_count,
             (SELECT COUNT(*) FROM candidates WHERE job_opening_id=jo.id AND stage='Hired')   AS hired_count
      FROM job_openings jo
      LEFT JOIN departments  d   ON d.id   = jo.department_id
      LEFT JOIN designations des ON des.id = jo.designation_id
      LEFT JOIN employees    e   ON e.id   = jo.hiring_manager_id
      LEFT JOIN users        u   ON u.id   = jo.created_by
      WHERE ${where}
      ORDER BY FIELD(jo.status,'Open','Draft','On Hold','Closed','Cancelled'), jo.created_at DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);

    res.json({ success: true, data: rows, meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total)/Number(limit)) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch jobs' });
  }
};

// ── POST /api/recruitment/jobs ────────────────────────────
const createJob = async (req, res) => {
  try {
    const { title, department_id, designation_id, employment_type, work_type, location,
            vacancies, min_experience, max_experience, min_salary, max_salary,
            description, requirements, skills, status, posted_date, closing_date,
            hiring_manager_id } = req.body;

    const [result] = await db.execute(`
      INSERT INTO job_openings
        (title, department_id, designation_id, employment_type, work_type, location,
         vacancies, min_experience, max_experience, min_salary, max_salary,
         description, requirements, skills, status, posted_date, closing_date,
         hiring_manager_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [title.trim(), department_id||null, designation_id||null, employment_type||'Full-Time',
       work_type||'On-site', location||null, vacancies||1, min_experience||0, max_experience||0,
       min_salary||null, max_salary||null, description||null, requirements||null,
       skills||null, status||'Draft', posted_date||null, closing_date||null,
       hiring_manager_id||null, req.user.id]);

    res.status(201).json({ success: true, message: 'Job opening created', data: { id: result.insertId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create job' });
  }
};

// ── PUT /api/recruitment/jobs/:id ─────────────────────────
const updateJob = async (req, res) => {
  try {
    const { title, department_id, designation_id, employment_type, work_type, location,
            vacancies, min_experience, max_experience, min_salary, max_salary,
            description, requirements, skills, status, posted_date, closing_date,
            hiring_manager_id } = req.body;

    await db.execute(`
      UPDATE job_openings SET
        title=?, department_id=?, designation_id=?, employment_type=?, work_type=?,
        location=?, vacancies=?, min_experience=?, max_experience=?,
        min_salary=?, max_salary=?, description=?, requirements=?, skills=?,
        status=?, posted_date=?, closing_date=?, hiring_manager_id=?
      WHERE id=?`,
      [title.trim(), department_id||null, designation_id||null, employment_type||'Full-Time',
       work_type||'On-site', location||null, vacancies||1, min_experience||0, max_experience||0,
       min_salary||null, max_salary||null, description||null, requirements||null,
       skills||null, status||'Draft', posted_date||null, closing_date||null,
       hiring_manager_id||null, req.params.id]);

    res.json({ success: true, message: 'Job updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
};

// ── GET /api/recruitment/jobs/:id/candidates ──────────────
const getJobCandidates = async (req, res) => {
  try {
    const { stage } = req.query;
    const conditions = ['c.job_opening_id = ?', 'c.is_active = 1'];
    const params = [req.params.id];
    if (stage) { conditions.push('c.stage = ?'); params.push(stage); }

    const [rows] = await db.execute(`
      SELECT c.*,
             e.full_name AS referral_name,
             (SELECT COUNT(*) FROM interviews WHERE candidate_id=c.id) AS interview_count,
             (SELECT MAX(scheduled_at) FROM interviews WHERE candidate_id=c.id AND status='Completed') AS last_interview
      FROM candidates c
      LEFT JOIN employees e ON e.id = c.referral_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.created_at DESC`, params);

    // Group by stage for kanban view
    const pipeline = {};
    rows.forEach(c => {
      if (!pipeline[c.stage]) pipeline[c.stage] = [];
      pipeline[c.stage].push(c);
    });

    res.json({ success: true, data: rows, pipeline });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch candidates' });
  }
};

// ── POST /api/recruitment/jobs/:id/candidates ─────────────
const addCandidate = async (req, res) => {
  try {
    const { full_name, email, phone, current_company, current_designation,
            total_experience, current_salary, expected_salary, notice_period,
            source, referral_by, cover_letter, skills, notes } = req.body;

    const [[dup]] = await db.execute(
      'SELECT id FROM candidates WHERE job_opening_id=? AND email=?',
      [req.params.id, email.toLowerCase().trim()]
    );
    if (dup) return res.status(409).json({ success: false, message: 'Candidate with this email already applied' });

    const resumePath = req.file ? req.file.filename : null;
    const resumeOrig = req.file ? req.file.originalname : null;

    const [result] = await db.execute(`
      INSERT INTO candidates
        (job_opening_id, full_name, email, phone, current_company, current_designation,
         total_experience, current_salary, expected_salary, notice_period,
         source, referral_by, resume_path, resume_original, cover_letter, skills, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id, full_name.trim(), email.toLowerCase().trim(), phone||null,
       current_company||null, current_designation||null, total_experience||0,
       current_salary||null, expected_salary||null, notice_period||0,
       source||'Other', referral_by||null, resumePath, resumeOrig,
       cover_letter||null, skills||null, notes||null]);

    res.status(201).json({ success: true, message: 'Candidate added', data: { id: result.insertId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to add candidate' });
  }
};

// ── PATCH /api/recruitment/candidates/:id/stage ───────────
const updateStage = async (req, res) => {
  try {
    const { stage, notes } = req.body;
    const validStages = ['Applied','Screening','Interview','Technical','HR Round','Offer','Hired','Rejected','Withdrawn'];
    if (!validStages.includes(stage)) return res.status(422).json({ success: false, message: 'Invalid stage' });

    await db.execute(
      'UPDATE candidates SET stage=?, notes=COALESCE(?,notes) WHERE id=?',
      [stage, notes||null, req.params.id]
    );

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `CANDIDATE_STAGE:${req.params.id}→${stage}`, 'recruitment', req.ip]
    );

    res.json({ success: true, message: `Moved to ${stage}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Stage update failed' });
  }
};

// ── PATCH /api/recruitment/candidates/:id/rating ──────────
const rateCandidate = async (req, res) => {
  try {
    const { rating, notes } = req.body;
    await db.execute('UPDATE candidates SET rating=?, notes=COALESCE(?,notes) WHERE id=?', [rating, notes||null, req.params.id]);
    res.json({ success: true, message: 'Rating saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Rating failed' });
  }
};

// ── GET /api/recruitment/candidates/:id ───────────────────
const getCandidate = async (req, res) => {
  try {
    const [[c]] = await db.execute(`
      SELECT c.*,
             jo.title AS job_title,
             d.name   AS department_name,
             e.full_name AS referral_name
      FROM candidates c
      JOIN job_openings jo ON jo.id = c.job_opening_id
      LEFT JOIN departments d ON d.id = jo.department_id
      LEFT JOIN employees   e ON e.id = c.referral_by
      WHERE c.id = ?`, [req.params.id]);

    if (!c) return res.status(404).json({ success: false, message: 'Candidate not found' });

    const [interviews] = await db.execute(`
      SELECT i.*, u.full_name AS created_by_name
      FROM interviews i
      LEFT JOIN users u ON u.id = i.created_by
      WHERE i.candidate_id = ?
      ORDER BY i.scheduled_at DESC`, [req.params.id]);

    res.json({ success: true, data: { ...c, interviews } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch candidate' });
  }
};

// ── POST /api/recruitment/candidates/:id/interviews ───────
const scheduleInterview = async (req, res) => {
  try {
    const [[c]] = await db.execute('SELECT job_opening_id FROM candidates WHERE id=?', [req.params.id]);
    if (!c) return res.status(404).json({ success: false, message: 'Candidate not found' });

    const { interview_type, scheduled_at, duration_mins, mode, location,
            meeting_link, interviewers, notes } = req.body;

    const [result] = await db.execute(`
      INSERT INTO interviews
        (candidate_id, job_opening_id, interview_type, scheduled_at, duration_mins,
         mode, location, meeting_link, interviewers, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id, c.job_opening_id, interview_type||'Screening', scheduled_at,
       duration_mins||60, mode||'In-Person', location||null, meeting_link||null,
       interviewers ? JSON.stringify(interviewers) : null, req.user.id]);

    // Auto-advance candidate stage
    const stageMap = { Screening:'Screening', Technical:'Technical', 'HR Round':'HR Round', Final:'HR Round', Other:'Interview' };
    const newStage = stageMap[interview_type] || 'Interview';
    await db.execute("UPDATE candidates SET stage=? WHERE id=? AND stage='Applied'", [newStage, req.params.id]);

    res.status(201).json({ success: true, message: 'Interview scheduled', data: { id: result.insertId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Schedule failed' });
  }
};

// ── PATCH /api/recruitment/interviews/:id ─────────────────
const updateInterview = async (req, res) => {
  try {
    const { status, feedback, rating, outcome } = req.body;
    await db.execute(
      'UPDATE interviews SET status=COALESCE(?,status), feedback=COALESCE(?,feedback), rating=COALESCE(?,rating), outcome=COALESCE(?,outcome) WHERE id=?',
      [status||null, feedback||null, rating||null, outcome||null, req.params.id]
    );
    res.json({ success: true, message: 'Interview updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
};

// ── GET /api/recruitment/interviews/upcoming ──────────────
const getUpcomingInterviews = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT i.*,
             c.full_name AS candidate_name, c.email AS candidate_email, c.stage,
             jo.title AS job_title,
             d.name  AS department_name
      FROM interviews i
      JOIN candidates  c  ON c.id  = i.candidate_id
      JOIN job_openings jo ON jo.id = i.job_opening_id
      LEFT JOIN departments d ON d.id = jo.department_id
      WHERE i.scheduled_at >= NOW() AND i.status = 'Scheduled'
      ORDER BY i.scheduled_at ASC LIMIT 20`);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
};

// ── Download resume ───────────────────────────────────────
const downloadResume = async (req, res) => {
  try {
    const [[c]] = await db.execute('SELECT resume_path, resume_original FROM candidates WHERE id=?', [req.params.id]);
    if (!c?.resume_path) return res.status(404).json({ success: false, message: 'No resume found' });
    const filePath = path.join(RESUME_DIR, c.resume_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'File not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${c.resume_original}"`);
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Download failed' });
  }
};

module.exports = {
  getStats, getJobs, createJob, updateJob,
  getJobCandidates, addCandidate, updateStage, rateCandidate, getCandidate,
  scheduleInterview, updateInterview, getUpcomingInterviews, downloadResume,
};