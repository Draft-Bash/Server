import * as nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

export async function sendInvitationEmails() {
  const html_body = `
    <h1>XXX has invited you to join their draft!</h1>
    <h3>Draft Date & Time:</h3>
    <p>This is a test</p>
    <img src="cid:special" width="400">
  `;

  // array of emails
  const emails: string[] = ['stephenpfeddes@gmail.com'];

  try {
    // where email is being sent from
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      // credentials of the email being used to send the information
      auth: {
        user: 'draftbashfantasy@gmail.com',
        pass: process.env.EMAIL_PASSWORD,
      },
      debug: true,
    });

    const info = await transporter.sendMail({
      from: 'DraftBashFantasy <draftbashfantasy@gmail.com>',
      to: emails,
      subject: 'New logo',
      html: html_body,
      attachments: [
        {
          filename: 'basketball.png',
          path: './images/basketball.png',
          cid: 'special',
        },
      ],
    });
  } catch (error) {
    console.log(error);
  }
}