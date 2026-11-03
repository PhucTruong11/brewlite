import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

type EmailDelivery =
  | { provider: 'smtp'; transporter: nodemailer.Transporter; from: string }
  | {
      provider: 'brevo';
      apiKey: string;
      sender: { email: string; name: string };
    };

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly delivery: EmailDelivery;

  constructor() {
    const provider = (process.env.MAIL_PROVIDER ?? 'smtp').trim().toLowerCase();
    if (provider === 'brevo') {
      const apiKey = process.env.BREVO_API_KEY?.trim();
      const email = process.env.BREVO_SENDER_EMAIL?.trim();
      if (!apiKey || !email) {
        throw new Error(
          'BREVO_API_KEY and BREVO_SENDER_EMAIL are required when MAIL_PROVIDER=brevo.',
        );
      }
      this.delivery = {
        provider,
        apiKey,
        sender: {
          email,
          name: process.env.BREVO_SENDER_NAME?.trim() || 'BrewLite',
        },
      };
    } else if (provider === 'smtp') {
      const port = Number(process.env.MAIL_PORT) || 587;
      this.delivery = {
        provider,
        from: process.env.MAIL_FROM || `"BrewLite" <${process.env.MAIL_USER}>`,
        transporter: nodemailer.createTransport({
          host: process.env.MAIL_HOST || 'smtp.gmail.com',
          port,
          secure: port === 465,
          auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASSWORD,
          },
        }),
      };
    } else {
      throw new Error('MAIL_PROVIDER must be smtp or brevo.');
    }
  }

  /**
   * Gửi email mã xác minh OTP khi đăng ký hoặc gửi lại mã
   */
  async sendOtpEmail(toEmail: string, otp: string): Promise<boolean> {
    const content = {
      subject: `[BrewLite] Mã xác minh tài khoản của bạn: ${otp}`,
      html: `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 16px; background-color: #ffffff;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h1 style="color: #006241; margin: 0; font-size: 24px; font-weight: 800;">BrewLite Coffee</h1>
            <p style="color: #666666; font-size: 14px; margin-top: 4px;">Xác minh địa chỉ Email</p>
          </div>
          
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          
          <p style="color: #333333; font-size: 15px; line-height: 1.5;">Chào bạn,</p>
          <p style="color: #555555; font-size: 14px; line-height: 1.5;">
            Bạn vừa yêu cầu mã xác minh tại <strong>BrewLite</strong>. Vui lòng sử dụng mã OTP dưới đây để hoàn tất yêu cầu:
          </p>
          
          <div style="text-align: center; margin: 30px 0;">
            <span style="display: inline-block; background-color: #f2f7f4; color: #006241; font-size: 32px; font-weight: 800; letter-spacing: 6px; padding: 12px 28px; border-radius: 12px; border: 1px dashed #006241;">
              ${otp}
            </span>
          </div>
          
          <p style="color: #777777; font-size: 13px; line-height: 1.5;">
            ⏰ Mã này có hiệu lực trong <strong>10 phút</strong>. Vì lý do bảo mật, vui lòng không chia sẻ mã này với bất kỳ ai.
          </p>
          
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          
          <p style="color: #999999; font-size: 12px; text-align: center; margin: 0;">
            Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.<br />
            &copy; ${new Date().getFullYear()} BrewLite. All rights reserved.
          </p>
        </div>
      `,
    };

    try {
      const delivery = this.delivery;
      if (delivery.provider === 'brevo') {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'api-key': delivery.apiKey,
          },
          body: JSON.stringify({
            sender: delivery.sender,
            to: [{ email: toEmail }],
            subject: content.subject,
            htmlContent: content.html,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          this.logger.error(
            `Brevo rejected the OTP email (HTTP ${response.status}).`,
          );
          return false;
        }
        const result = (await response.json()) as {
          messageId?: unknown;
        } | null;
        if (typeof result?.messageId !== 'string' || !result.messageId) {
          this.logger.error('Brevo did not return an email message ID.');
          return false;
        }
      } else {
        const info = await delivery.transporter.sendMail({
          from: delivery.from,
          to: toEmail,
          ...content,
        });
        if (!Array.isArray(info.accepted) || info.accepted.length === 0) {
          this.logger.error('SMTP did not accept the OTP email recipient.');
          return false;
        }
      }
      this.logger.log(`OTP email accepted by ${delivery.provider}.`);
      return true;
    } catch {
      // Provider errors can contain credentials, recipient addresses or message content.
      this.logger.error(
        `OTP email delivery failed (${this.delivery.provider}).`,
      );
      return false;
    }
  }
}
