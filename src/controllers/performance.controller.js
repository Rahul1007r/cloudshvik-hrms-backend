const db = require('../config/db');

// ── helpers ───────────────────────────────────────────────
const RATING_LABELS = [
  { min: 4.5, label: 'Outstanding',          color: '#059669' },
  { min: 3.5, label: 'Exceeds Expectations', color: '#16a34a' },
  { min: 2.5, label: 'Meets Expectations',   color: '#006bb7' },
  { min: 1.5, label: 'Needs Improvement',    color: '#d97706' },
  { min: 0,   label: 'Unsatisfactory',       color: '#dc2626' },
];
const getRatingLabel = (r) => RATING_LABELS.find(l => r >= l.min)?.label || '—';

const getSelfEmpId = async (userId) => {
  const [[r]] = await db.execute('SELECT id FROM employees WHERE user_id=? AND is_active=1', [userId]);
  return r?.id || null;
};

// ═══════════════════════════════════════════════════════════
// REVIEW CYCLES
// ═══════════════════════════════════════════════════════════

// GET /api/performance/cycles
const getCycles = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT rc.*,
             u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM performance_reviews WHERE review_cycle_id=rc.id) AS review_count,
             (SELECT COUNT(*) FROM performance_reviews WHERE review_cycle_id=rc.id AND status='Completed') AS completed_count
      FROM review_cycles rc
      LEFT JOIN users u ON u.id = rc.created_by
      ORDER BY rc.start_date DESC`);
    res.json({ success:true, data:rows });
  } catch(err) { res.status(500).json({ success:false, message:'Failed to fetch cycles' }); }
};

// POST /api/performance/cycles
const createCycle = async (req, res) => {
  try {
    const { name, cycle_type, start_date, end_date, review_from, review_to, description } = req.body;
    const [r] = await db.execute(
      'INSERT INTO review_cycles (name,cycle_type,start_date,end_date,review_from,review_to,description,created_by) VALUES (?,?,?,?,?,?,?,?)',
      [name.trim(), cycle_type||'Annual', start_date, end_date, review_from, review_to, description||null, req.user.id]
    );
    res.status(201).json({ success:true, message:'Review cycle created', data:{ id:r.insertId } });
  } catch(err) { res.status(500).json({ success:false, message:'Failed to create cycle' }); }
};

// PATCH /api/performance/cycles/:id/status
const updateCycleStatus = async (req, res) => {
  try {
    await db.execute('UPDATE review_cycles SET status=? WHERE id=?', [req.body.status, req.params.id]);
    res.json({ success:true, message:'Cycle status updated' });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// POST /api/performance/cycles/:id/launch
// Creates review records for all active employees
const launchCycle = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const cycleId = req.params.id;
    const [[cycle]] = await conn.execute('SELECT * FROM review_cycles WHERE id=?', [cycleId]);
    if (!cycle) { await conn.rollback(); return res.status(404).json({ success:false, message:'Cycle not found' }); }

    const [employees] = await conn.execute(`
      SELECT e.id, e.manager_id
      FROM employees e WHERE e.is_active=1`);

    let created = 0, skipped = 0;
    for (const emp of employees) {
      const [[dup]] = await conn.execute(
        'SELECT id FROM performance_reviews WHERE employee_id=? AND review_cycle_id=?',
        [emp.id, cycleId]
      );
      if (dup) { skipped++; continue; }

      const reviewerId = emp.manager_id || req.user.id;
      const [[revEmp]] = await conn.execute('SELECT id FROM employees WHERE user_id=?', [req.user.id]);

      await conn.execute(
        'INSERT INTO performance_reviews (employee_id, reviewer_id, review_cycle_id, status) VALUES (?,?,?,?)',
        [emp.id, emp.manager_id || (revEmp?.id||1), cycleId, 'Pending Self']
      );
      created++;
    }

    await conn.execute("UPDATE review_cycles SET status='Active' WHERE id=?", [cycleId]);
    await conn.commit();
    res.json({ success:true, message:`Cycle launched: ${created} reviews created, ${skipped} skipped`, data:{ created, skipped } });
  } catch(err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success:false, message:'Launch failed' });
  } finally { conn.release(); }
};

// ═══════════════════════════════════════════════════════════
// GOALS
// ═══════════════════════════════════════════════════════════

// GET /api/performance/goals
const getGoals = async (req, res) => {
  try {
    const { employee_id, cycle_id, status } = req.query;
    const selfEmpId = await getSelfEmpId(req.user.id);
    const isAdminHR = ['Admin','HR','Manager'].includes(req.user.role_name);

    const conditions = ['1=1']; const params = [];

    if (employee_id) { conditions.push('pg.employee_id=?'); params.push(employee_id); }
    else if (!isAdminHR && selfEmpId) { conditions.push('pg.employee_id=?'); params.push(selfEmpId); }

    if (cycle_id) { conditions.push('pg.review_cycle_id=?'); params.push(cycle_id); }
    if (status)   { conditions.push('pg.status=?');          params.push(status); }

    const [rows] = await db.execute(`
      SELECT pg.*,
             e.full_name, e.employee_id AS emp_code,
             d.name AS department,
             rc.name AS cycle_name
      FROM performance_goals pg
      JOIN employees e ON e.id = pg.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN review_cycles rc ON rc.id = pg.review_cycle_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY pg.created_at DESC`, params);

    res.json({ success:true, data:rows });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Failed to fetch goals' });
  }
};

// POST /api/performance/goals
const createGoal = async (req, res) => {
  try {
    const { employee_id, review_cycle_id, title, description, category, goal_type,
            target_value, weightage, due_date } = req.body;

    const empId = employee_id || await getSelfEmpId(req.user.id);
    if (!empId) return res.status(404).json({ success:false, message:'Employee not found' });

    const [r] = await db.execute(`
      INSERT INTO performance_goals
        (employee_id, review_cycle_id, title, description, category, goal_type,
         target_value, weightage, due_date, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [empId, review_cycle_id||null, title.trim(), description||null,
       category||'Individual', goal_type||'KPI',
       target_value||null, weightage||0, due_date||null, req.user.id]
    );
    res.status(201).json({ success:true, message:'Goal created', data:{ id:r.insertId } });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Failed to create goal' });
  }
};

// PATCH /api/performance/goals/:id
const updateGoal = async (req, res) => {
  try {
    const { title, description, target_value, actual_value, progress_pct, status, due_date, weightage } = req.body;
    await db.execute(`
      UPDATE performance_goals SET
        title=COALESCE(?,title), description=COALESCE(?,description),
        target_value=COALESCE(?,target_value), actual_value=COALESCE(?,actual_value),
        progress_pct=COALESCE(?,progress_pct), status=COALESCE(?,status),
        due_date=COALESCE(?,due_date), weightage=COALESCE(?,weightage)
      WHERE id=?`,
      [title||null, description||null, target_value||null, actual_value||null,
       progress_pct??null, status||null, due_date||null, weightage??null, req.params.id]
    );
    res.json({ success:true, message:'Goal updated' });
  } catch(err) { res.status(500).json({ success:false, message:'Update failed' }); }
};

// DELETE /api/performance/goals/:id
const deleteGoal = async (req, res) => {
  try {
    await db.execute('DELETE FROM performance_goals WHERE id=?', [req.params.id]);
    res.json({ success:true, message:'Goal deleted' });
  } catch(err) { res.status(500).json({ success:false, message:'Delete failed' }); }
};

// ═══════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════

// GET /api/performance/reviews
const getReviews = async (req, res) => {
  try {
    const { cycle_id, status, employee_id, page=1, limit=15 } = req.query;
    const selfEmpId = await getSelfEmpId(req.user.id);
    const isAdminHR = ['Admin','HR'].includes(req.user.role_name);
    const isMgr     = req.user.role_name === 'Manager';

    const conditions = ['1=1']; const params = [];

    if (employee_id) { conditions.push('pr.employee_id=?'); params.push(employee_id); }
    else if (!isAdminHR && !isMgr && selfEmpId) {
      conditions.push('pr.employee_id=?'); params.push(selfEmpId);
    } else if (isMgr && selfEmpId && !employee_id) {
      conditions.push('pr.reviewer_id=?'); params.push(selfEmpId);
    }

    if (cycle_id) { conditions.push('pr.review_cycle_id=?'); params.push(cycle_id); }
    if (status)   { conditions.push('pr.status=?');          params.push(status); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page)-1)*Number(limit);

    const [[{total}]] = await db.execute(
      `SELECT COUNT(*) AS total FROM performance_reviews pr WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT pr.*,
             e.full_name, e.employee_id AS emp_code,
             d.name AS department, des.name AS designation,
             re.full_name AS reviewer_name,
             rc.name AS cycle_name, rc.cycle_type, rc.review_from, rc.review_to
      FROM performance_reviews pr
      JOIN employees  e   ON e.id   = pr.employee_id
      LEFT JOIN departments  d   ON d.id   = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      LEFT JOIN employees    re  ON re.id  = pr.reviewer_id
      JOIN review_cycles rc ON rc.id = pr.review_cycle_id
      WHERE ${where}
      ORDER BY FIELD(pr.status,'Pending Self','Pending Manager','Pending HR','Completed','Cancelled'), pr.created_at DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);

    res.json({ success:true, data:rows, meta:{ total:Number(total), page:Number(page), pages:Math.ceil(Number(total)/Number(limit)) } });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Failed to fetch reviews' });
  }
};

// GET /api/performance/reviews/:id
const getReview = async (req, res) => {
  try {
    const [[pr]] = await db.execute(`
      SELECT pr.*,
             e.full_name, e.employee_id AS emp_code, e.email,
             d.name AS department, des.name AS designation, e.joining_date,
             re.full_name AS reviewer_name,
             rc.name AS cycle_name, rc.cycle_type, rc.review_from, rc.review_to, rc.end_date AS cycle_end
      FROM performance_reviews pr
      JOIN employees  e   ON e.id   = pr.employee_id
      LEFT JOIN departments  d   ON d.id   = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      LEFT JOIN employees    re  ON re.id  = pr.reviewer_id
      JOIN review_cycles rc ON rc.id = pr.review_cycle_id
      WHERE pr.id=?`, [req.params.id]);

    if (!pr) return res.status(404).json({ success:false, message:'Review not found' });

    const [competencies] = await db.execute(
      'SELECT * FROM review_competencies WHERE review_id=? ORDER BY id', [req.params.id]
    );
    const [goals] = await db.execute(
      'SELECT * FROM performance_goals WHERE employee_id=? AND review_cycle_id=? ORDER BY weightage DESC',
      [pr.employee_id, pr.review_cycle_id]
    );
    const [devPlans] = await db.execute(
      'SELECT * FROM development_plans WHERE review_id=? ORDER BY created_at DESC', [req.params.id]
    );

    res.json({ success:true, data:{ ...pr, competencies, goals, devPlans } });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Failed to fetch review' });
  }
};

// POST /api/performance/reviews/:id/self-assessment
const submitSelfAssessment = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { self_rating, self_comments, competencies=[] } = req.body;
    const selfEmpId = await getSelfEmpId(req.user.id);

    const [[pr]] = await conn.execute('SELECT * FROM performance_reviews WHERE id=?', [req.params.id]);
    if (!pr) { await conn.rollback(); return res.status(404).json({ success:false, message:'Review not found' }); }
    if (pr.employee_id !== selfEmpId && !['Admin','HR'].includes(req.user.role_name)) {
      await conn.rollback();
      return res.status(403).json({ success:false, message:'Access denied' });
    }

    await conn.execute(
      "UPDATE performance_reviews SET self_rating=?, self_comments=?, self_submitted_at=NOW(), status='Pending Manager' WHERE id=?",
      [self_rating, self_comments||null, req.params.id]
    );

    // Upsert competencies
    for (const c of competencies) {
      if (c.id) {
        await conn.execute('UPDATE review_competencies SET self_rating=? WHERE id=?', [c.self_rating, c.id]);
      } else {
        await conn.execute(
          'INSERT INTO review_competencies (review_id, name, category, self_rating) VALUES (?,?,?,?)',
          [req.params.id, c.name, c.category||'Behavioral', c.self_rating||0]
        );
      }
    }

    await conn.commit();
    res.json({ success:true, message:'Self-assessment submitted' });
  } catch(err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success:false, message:'Submission failed' });
  } finally { conn.release(); }
};

// POST /api/performance/reviews/:id/manager-review
const submitManagerReview = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { manager_rating, manager_comments, manager_strengths, manager_improvements,
            competencies=[], goal_ratings=[], dev_plans=[] } = req.body;

    const [[pr]] = await conn.execute('SELECT * FROM performance_reviews WHERE id=?', [req.params.id]);
    if (!pr) { await conn.rollback(); return res.status(404).json({ success:false, message:'Review not found' }); }

    // Calculate weighted goal score
    let goalScore = 0, totalWeight = 0;
    for (const gr of goal_ratings) {
      await conn.execute('UPDATE performance_goals SET rating=?, actual_value=?, progress_pct=? WHERE id=?',
        [gr.rating, gr.actual_value||null, gr.progress_pct||0, gr.id]);
      goalScore    += Number(gr.rating||0) * Number(gr.weightage||0);
      totalWeight  += Number(gr.weightage||0);
    }
    const goalAvg = totalWeight > 0 ? goalScore / totalWeight : 0;

    // Compute overall rating (avg of manager rating + goal avg)
    const overall = goalAvg > 0
      ? parseFloat(((Number(manager_rating) * 0.6 + goalAvg * 0.4)).toFixed(1))
      : parseFloat(Number(manager_rating).toFixed(1));

    const label = getRatingLabel(overall);

    await conn.execute(`
      UPDATE performance_reviews SET
        manager_rating=?, manager_comments=?, manager_strengths=?,
        manager_improvements=?, manager_submitted_at=NOW(),
        overall_rating=?, rating_label=?, final_rating=?, final_label=?,
        status='Pending HR'
      WHERE id=?`,
      [manager_rating, manager_comments||null, manager_strengths||null,
       manager_improvements||null, overall, label, overall, label, req.params.id]
    );

    // Update competency manager ratings
    for (const c of competencies) {
      if (c.id) {
        await conn.execute('UPDATE review_competencies SET manager_rating=?, comments=? WHERE id=?',
          [c.manager_rating, c.comments||null, c.id]);
      }
    }

    // Add development plans
    for (const dp of dev_plans) {
      if (!dp.title?.trim()) continue;
      await conn.execute(`
        INSERT INTO development_plans (employee_id, review_id, title, description, action_items, due_date, created_by)
        VALUES (?,?,?,?,?,?,?)`,
        [pr.employee_id, pr.id, dp.title.trim(), dp.description||null,
         dp.action_items ? JSON.stringify(dp.action_items) : null, dp.due_date||null, req.user.id]
      );
    }

    await conn.commit();
    res.json({ success:true, message:'Manager review submitted. Overall rating: ' + overall });
  } catch(err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success:false, message:'Review submission failed' });
  } finally { conn.release(); }
};

// POST /api/performance/reviews/:id/complete
const completeReview = async (req, res) => {
  try {
    const { hr_comments, hr_rating } = req.body;
    await db.execute(`
      UPDATE performance_reviews SET
        hr_comments=?, hr_rating=COALESCE(NULLIF(?,''),overall_rating),
        final_rating=COALESCE(NULLIF(?,''),overall_rating),
        final_label=?, status='Completed'
      WHERE id=?`,
      [hr_comments||null, hr_rating||null, hr_rating||null,
       getRatingLabel(hr_rating||0), req.params.id]
    );
    res.json({ success:true, message:'Review completed' });
  } catch(err) { res.status(500).json({ success:false, message:'Complete failed' }); }
};

// ═══════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════

const getStats = async (req, res) => {
  try {
    const [[reviews]] = await db.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(status='Pending Self')    AS pending_self,
        SUM(status='Pending Manager') AS pending_manager,
        SUM(status='Pending HR')      AS pending_hr,
        SUM(status='Completed')       AS completed,
        ROUND(AVG(NULLIF(final_rating,0)),1) AS avg_rating
      FROM performance_reviews`);

    const [[goals]] = await db.execute(`
      SELECT COUNT(*) AS total,
             SUM(status='Active')    AS active,
             SUM(status='Completed') AS completed,
             SUM(status='Missed')    AS missed,
             ROUND(AVG(progress_pct),0) AS avg_progress
      FROM performance_goals`);

    const [ratingDist] = await db.execute(`
      SELECT final_label, COUNT(*) AS count
      FROM performance_reviews
      WHERE status='Completed' AND final_rating > 0
      GROUP BY final_label ORDER BY final_rating DESC`);

    const [activeCycles] = await db.execute(
      "SELECT id, name, cycle_type, status FROM review_cycles WHERE status IN ('Active','Reviewing') ORDER BY start_date DESC LIMIT 3"
    );

    res.json({ success:true, data:{ reviews, goals, ratingDist, activeCycles } });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Stats failed' });
  }
};

// GET /api/performance/my-review
const getMyReview = async (req, res) => {
  try {
    const selfEmpId = await getSelfEmpId(req.user.id);
    if (!selfEmpId) return res.status(404).json({ success:false, message:'Employee not found' });

    const [reviews] = await db.execute(`
      SELECT pr.id, pr.status, pr.self_rating, pr.manager_rating, pr.final_rating,
             pr.final_label, pr.overall_rating,
             rc.name AS cycle_name, rc.cycle_type, rc.end_date AS cycle_end
      FROM performance_reviews pr
      JOIN review_cycles rc ON rc.id = pr.review_cycle_id
      WHERE pr.employee_id=? AND pr.status != 'Cancelled'
      ORDER BY pr.created_at DESC LIMIT 5`, [selfEmpId]
    );

    const [goals] = await db.execute(
      "SELECT * FROM performance_goals WHERE employee_id=? ORDER BY created_at DESC LIMIT 10", [selfEmpId]
    );

    res.json({ success:true, data:{ reviews, goals } });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

module.exports = {
  getCycles, createCycle, updateCycleStatus, launchCycle,
  getGoals, createGoal, updateGoal, deleteGoal,
  getReviews, getReview, submitSelfAssessment, submitManagerReview, completeReview,
  getStats, getMyReview,
};