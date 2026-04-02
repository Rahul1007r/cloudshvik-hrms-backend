const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT),
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

const sendPasswordResetOTP = async (email, name, otp) => {
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to:   email,
    subject: 'HRMS — Password Reset OTP',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 32px;">
        <div style="background:#006bb7; border-radius:8px; padding:24px; text-align:center;">
          <h1 style="color:#fff; margin:0; font-size:22px;">HRMS Portal</h1>
        </div>
        <div style="padding:24px 0;">
          <p>Hi <strong>${name}</strong>,</p>
          <p>Your password reset OTP is:</p>
          <div style="background:#f0f7ff; border:2px dashed #006bb7; border-radius:8px;
                      text-align:center; padding:20px; margin:20px 0;">
            <span style="font-size:36px; font-weight:700; letter-spacing:10px; color:#006bb7;">
              ${otp}
            </span>
          </div>
          <p style="color:#666; font-size:13px;">
            This OTP expires in <strong>15 minutes</strong>. Do not share it with anyone.
          </p>
        </div>
        <hr style="border:none; border-top:1px solid #eee;" />
        <p style="color:#999; font-size:12px; text-align:center;">
          If you didn't request this, ignore this email.
        </p>
      </div>
    `,
  });
};

module.exports = { sendPasswordResetOTP };