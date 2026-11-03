import {
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuthService } from './auth.service.js';

const { hash, compare } = vi.hoisted(() => ({
  hash: vi.fn(),
  compare: vi.fn(),
}));
vi.mock('bcrypt', () => ({ hash, compare }));

describe('AuthService OTP delivery failures', () => {
  const email = 'customer@example.com';
  const pendingUser = {
    id: 'user-1',
    email,
    passwordHash: 'password-hash',
    emailVerifiedAt: null,
    role: 'USER',
  };
  const prisma = {
    user: { findUnique: vi.fn(), create: vi.fn() },
    emailVerification: { create: vi.fn(), upsert: vi.fn() },
    passwordReset: { upsert: vi.fn() },
  };
  const mail = { sendOtpEmail: vi.fn() };
  const jwt = { sign: vi.fn() };
  const service = new AuthService(prisma as never, mail as never, jwt as never);

  beforeEach(() => {
    vi.resetAllMocks();
    hash.mockResolvedValue('password-hash');
    compare.mockResolvedValue(true);
    mail.sendOtpEmail.mockResolvedValue(true);
    prisma.user.create.mockResolvedValue(pendingUser);
    prisma.emailVerification.create.mockResolvedValue({});
    prisma.emailVerification.upsert.mockResolvedValue({});
    prisma.passwordReset.upsert.mockResolvedValue({});
    jwt.sign.mockReturnValue('signed-token');
  });

  it('sends the same registration OTP whose hash is stored in the database', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const result = await service.register({
      email: 'Customer@Example.com',
      password: 'test-password',
    });
    const [to, otp] = mail.sendOtpEmail.mock.calls[0]!;
    expect(to).toBe(email);
    expect(otp).toMatch(/^\d{6}$/);
    expect(prisma.emailVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: pendingUser.id,
          codeHash: createHash('sha256').update(otp).digest('hex'),
        }),
      }),
    );
    expect(result.email).toBe(email);
  });

  it('returns 503 and explains how to recover a pending registration when delivery fails', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    mail.sendOtpEmail.mockResolvedValue(false);
    await expect(
      service.register({ email, password: 'test-password' }),
    ).rejects.toMatchObject({
      status: 503,
      response: {
        code: 'EMAIL_DELIVERY_FAILED',
        message: expect.stringContaining('Tài khoản đã được tạo'),
      },
    });
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('guides a repeated registration for the pending email to the verification flow', async () => {
    prisma.user.findUnique.mockResolvedValue(pendingUser);
    await expect(
      service.register({ email, password: 'test-password' }),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.register({ email, password: 'test-password' }),
    ).rejects.toThrow('chưa xác minh');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(mail.sendOtpEmail).not.toHaveBeenCalled();
  });

  it('does not return a resend success message after failed delivery', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...pendingUser,
      emailVerification: null,
    });
    mail.sendOtpEmail.mockResolvedValue(false);
    await expect(service.resendVerification({ email })).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(mail.sendOtpEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps successful resends and their 60-second cooldown', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      ...pendingUser,
      emailVerification: null,
    });
    await expect(service.resendVerification({ email })).resolves.toMatchObject({
      message: expect.any(String),
    });
    prisma.user.findUnique.mockResolvedValueOnce({
      ...pendingUser,
      emailVerification: { lastSentAt: new Date() },
    });
    await expect(service.resendVerification({ email })).rejects.toThrow(
      'Vui lòng chờ',
    );
    expect(mail.sendOtpEmail).toHaveBeenCalledTimes(1);
  });

  it.each([null, { ...pendingUser, emailVerifiedAt: new Date() }])(
    'does not send a resend OTP for an absent or verified account',
    async (user) => {
      prisma.user.findUnique.mockResolvedValue(user);
      await expect(
        service.resendVerification({ email }),
      ).resolves.toMatchObject({ message: expect.any(String) });
      expect(mail.sendOtpEmail).not.toHaveBeenCalled();
    },
  );

  it('does not report a password-reset OTP as sent when delivery fails', async () => {
    prisma.user.findUnique.mockResolvedValue(pendingUser);
    mail.sendOtpEmail.mockResolvedValue(false);
    await expect(service.forgotPassword({ email })).rejects.toMatchObject({
      status: 503,
      response: { code: 'EMAIL_DELIVERY_FAILED' },
    });
  });

  it('keeps the successful password-reset flow and normalizes its email', async () => {
    prisma.user.findUnique.mockResolvedValue(pendingUser);
    await expect(
      service.forgotPassword({ email: ' Customer@Example.com ' }),
    ).resolves.toMatchObject({
      message: expect.stringContaining('đã được gửi'),
    });
    expect(mail.sendOtpEmail).toHaveBeenCalledWith(
      email,
      expect.stringMatching(/^\d{6}$/),
    );
  });

  it('keeps verified login independent of the email provider', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...pendingUser,
      role: 'ADMIN',
      emailVerifiedAt: new Date(),
    });
    mail.sendOtpEmail.mockResolvedValue(false);
    await expect(
      service.login({ email, password: 'test-password' }),
    ).resolves.toMatchObject({
      accessToken: 'signed-token',
      user: { id: pendingUser.id, role: 'ADMIN' },
    });
    expect(jwt.sign).toHaveBeenCalledWith({
      sub: pendingUser.id,
      email,
      role: 'ADMIN',
    });
    expect(mail.sendOtpEmail).not.toHaveBeenCalled();
  });

  it('still blocks login until email verification succeeds', async () => {
    prisma.user.findUnique.mockResolvedValue(pendingUser);
    await expect(
      service.login({ email, password: 'test-password' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(jwt.sign).not.toHaveBeenCalled();
    expect(mail.sendOtpEmail).not.toHaveBeenCalled();
  });
});
