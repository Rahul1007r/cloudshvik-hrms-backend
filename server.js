const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

require('./src/config/db');

const authRoutes       = require('./src/routes/auth.routes');
const rolesRoutes      = require('./src/routes/roles.routes');
const dashboardRoutes  = require('./src/routes/dashboard.routes');
const empDashRoutes    = require('./src/routes/employeeDashboard.routes');
const employeesRoutes  = require('./src/routes/employees.routes');
const attendanceRoutes = require('./src/routes/attendance.routes');
const orgRoutes        = require('./src/routes/orgstructure.routes');
const leaveRoutes      = require('./src/routes/leave.routes');
const payrollRoutes    = require('./src/routes/payroll.routes');   // ← Module 15

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.set('trust proxy', 1);

app.use('/api/auth',               authRoutes);
app.use('/api/roles',              rolesRoutes);
app.use('/api/dashboard',          dashboardRoutes);
app.use('/api/employee-dashboard', empDashRoutes);
app.use('/api/employees',          employeesRoutes);
app.use('/api/attendance',         attendanceRoutes);
app.use('/api',                    orgRoutes);
app.use('/api/leave',              leaveRoutes);
app.use('/api/payroll',            payrollRoutes);             // ← Module 15

app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.use((req, res) => res.status(404).json({ success: false, message: `Route ${req.url} not found` }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ success: false, message: 'Internal server error' }); });

app.listen(PORT, () => console.log(`🚀 HRMS Backend running on http://localhost:${PORT}`));
module.exports = app;