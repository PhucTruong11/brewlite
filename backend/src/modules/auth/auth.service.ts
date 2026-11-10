import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../email/email.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { ResendVerificationDto } from './dto/resend-verification.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { ForgotPasswordDto, ResetPasswordDto, ChangePasswordDto } from './dto/auth-password.dto.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly jwtService: JwtService,
  ) {}

  // Các trường trả về cho trang "Tài khoản của tôi"
  private readonly profileSelect = {
    id: true,
    email: true,
    fullName: true,
    phone: true,
    loyaltyPoints: true,
    createdAt: true,
    updatedAt: true,
  };

  private hashOtp(otp: string): string {
    return crypto.createHash('sha256').update(otp).digest('hex');
  }

  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private async sendOtpOrThrow(
    email: string,
    otp: string,
    failureMessage = 'Không thể gửi mã xác minh lúc này. Vui lòng thử lại sau.',
  ) {
    if (!(await this.emailService.sendOtpEmail(email, otp))) {
      throw new ServiceUnavailableException({
        code: 'EMAIL_DELIVERY_FAILED',
        message: failureMessage,
      });
    }
  }

  async register(dto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException(
        existingUser.emailVerifiedAt
          ? 'Email này đã được sử dụng'
          : 'Email này đã đăng ký nhưng chưa xác minh. Vui lòng đăng nhập và chọn xác minh email để gửi lại mã.',
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
      },
    });

    const otp = this.generateOtp();
    const codeHash = this.hashOtp(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await this.prisma.emailVerification.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt,
      },
    });

    await this.sendOtpOrThrow(
      user.email,
      otp,
      'Tài khoản đã được tạo nhưng chưa gửi được mã xác minh. Vui lòng đăng nhập và chọn xác minh email để gửi lại mã.',
    );

    return {
      message: 'Đăng ký thành công. Vui lòng kiểm tra email để lấy mã OTP xác minh.',
      email: user.email,
    };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: { emailVerification: true },
    });

    if (!user) {
      throw new BadRequestException('Mã xác minh không hợp lệ hoặc đã hết hạn');
    }

    if (user.emailVerifiedAt) {
      return { message: 'Tài khoản này đã được xác minh trước đó' };
    }

    const verification = user.emailVerification;
    if (!verification) {
      throw new BadRequestException('Không tìm thấy yêu cầu xác minh');
    }

    if (verification.attempts >= 5) {
      throw new BadRequestException('Bạn đã nhập sai quá 5 lần. Vui lòng yêu cầu gửi lại mã mới.');
    }

    if (new Date() > verification.expiresAt) {
      throw new BadRequestException('Mã OTP đã hết hạn. Vui lòng gửi lại mã mới.');
    }

    const inputHash = this.hashOtp(dto.code);
    if (inputHash !== verification.codeHash) {
      await this.prisma.emailVerification.update({
        where: { id: verification.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Mã OTP không chính xác');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      }),
      this.prisma.emailVerification.delete({
        where: { id: verification.id },
      }),
    ]);

    return { message: 'Xác minh email thành công! Bạn có thể đăng nhập ngay bây giờ.' };
  }

  async resendVerification(dto: ResendVerificationDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: { emailVerification: true },
    });

    const genericResponse = {
      message: 'Nếu email tồn tại và chưa xác minh, mã OTP mới đã được gửi.',
    };

    if (!user || user.emailVerifiedAt) {
      return genericResponse;
    }

    const existingVerification = user.emailVerification;

    if (existingVerification) {
      const timeDiff = (Date.now() - existingVerification.lastSentAt.getTime()) / 1000;
      if (timeDiff < 60) {
        throw new BadRequestException(`Vui lòng chờ ${Math.ceil(60 - timeDiff)} giây trước khi gửi lại.`);
      }
    }

    const otp = this.generateOtp();
    const codeHash = this.hashOtp(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await this.prisma.emailVerification.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        codeHash,
        expiresAt,
      },
      update: {
        codeHash,
        expiresAt,
        attempts: 0,
        lastSentAt: new Date(),
      },
    });

    await this.sendOtpOrThrow(user.email, otp);

    return genericResponse;
  }

    async login(dto: LoginDto) {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email.toLowerCase() },
      });

      

      if (!user) {
        throw new UnauthorizedException('Email hoặc mật khẩu không chính xác');
      }

      const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
      if (!isPasswordValid) {
        throw new UnauthorizedException('Email hoặc mật khẩu không chính xác');
      }

      if (!user.emailVerifiedAt) {
        throw new UnauthorizedException({
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Tài khoản chưa được xác minh email. Vui lòng xác minh OTP trước khi đăng nhập.',
          email: user.email,
        });
      }

      const userRole = (user as any).role || 'USER';

      const payload = { sub: user.id, email: user.email, role: userRole };
      const accessToken = this.jwtService.sign(payload);

      return {
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          phone: user.phone,
          role: userRole,
          loyaltyPoints: user.loyaltyPoints,
        },
      };
    }

// 1. Gửi OTP Quên mật khẩu
  async forgotPassword(dto: ForgotPasswordDto) {
    const cleanEmail = dto.email.trim().toLowerCase(); // <--- ĐỒNG BỘ LOWERCASE

    const user = await this.prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!user) {
      throw new NotFoundException('Không tìm thấy tài khoản với email này!');
    }

    // Tạo OTP 6 chữ số
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 phút

    await this.prisma.passwordReset.upsert({
      where: { email: cleanEmail },
      update: { codeHash, expiresAt, attempts: 0 },
      create: { email: cleanEmail, codeHash, expiresAt },
    });

    // Gửi Mail OTP
    await this.sendOtpOrThrow(cleanEmail, otp);

    return { message: 'Mã OTP đã được gửi về email của bạn.' };
  }

  // 2. Đặt lại mật khẩu bằng OTP
  async resetPassword(dto: ResetPasswordDto) {
    const cleanEmail = dto.email.trim().toLowerCase(); // <--- ĐỒNG BỘ LOWERCASE

    const record = await this.prisma.passwordReset.findUnique({
      where: { email: cleanEmail },
    });

    if (!record) {
      throw new BadRequestException('Mã OTP không hợp lệ hoặc đã bị hủy!');
    }

    if (new Date() > record.expiresAt) {
      throw new BadRequestException('Mã OTP đã hết hạn. Vui lòng lấy mã mới!');
    }

    const isValidOtp = await bcrypt.compare(dto.otp.trim(), record.codeHash);
    if (!isValidOtp) {
      throw new BadRequestException('Mã OTP không chính xác!');
    }

    // Hash mật khẩu mới (loại bỏ khoảng trắng thừa nếu có)
    const newPasswordHash = await bcrypt.hash(dto.newPassword.trim(), 10);

    // Cập nhật đúng trường passwordHash với email đã lowercase
    await this.prisma.user.update({
      where: { email: cleanEmail },
      data: { passwordHash: newPasswordHash },
    });

    // Xóa bản ghi OTP
    await this.prisma.passwordReset.delete({
      where: { email: cleanEmail },
    });

    return { message: 'Đặt lại mật khẩu thành công!' };
  }

    // 3. Đổi mật khẩu trong trang Profile (Khi ĐÃ ĐĂNG NHẬP)
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Người dùng không tồn tại!');
    }

    // Kiểm tra mật khẩu cũ với passwordHash hiện tại
    const isMatch = await bcrypt.compare(dto.oldPassword, user.passwordHash); // <--- passwordHash
    if (!isMatch) {
      throw new BadRequestException('Mật khẩu hiện tại không chính xác!');
    }

    // Hash mật khẩu mới
    const newPasswordHash = await bcrypt.hash(dto.newPassword, 10);

    // Cập nhật lại passwordHash
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash }, // <--- passwordHash
    });

    return { message: 'Đổi mật khẩu thành công!' };
  }

  // ==========================================
  // Hồ sơ cá nhân & sổ địa chỉ
  // ==========================================

  async getUserProfile(userId: string) {
    if (!userId) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        role: true, 
        loyaltyPoints: true,
      },
    });
    if (!user) throw new NotFoundException('Người dùng không tồn tại');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (!userId) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.fullName !== undefined && { fullName: dto.fullName?.trim() || null }),
        ...(dto.phone !== undefined && { phone: dto.phone?.trim() || null }),
      },
      select: this.profileSelect,
    });
  }
  
}
