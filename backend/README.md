# BrewLite API

API NestJS cho menu, xác thực, giỏ/kiểm tra nguyên liệu, tạo đơn, checkout mô phỏng, điểm thưởng và admin. Hướng dẫn **chạy cả hệ thống** và xử lý DB nằm ở [README gốc](../README.md) và [Docker README](../docker/README.md). Dùng các tài liệu đó khi mới pull code; không chạy seed trên DB đã có đơn.

## Cấu trúc nghiệp vụ

| Module | Chức năng |
| --- | --- |
| `products`, `inventory` | Danh mục, công thức, kiểm tra giỏ và giữ/trừ/trả nguyên liệu |
| `orders` | Tạo đơn `PENDING` cho user đã đăng nhập, lưu snapshot công thức và giữ nguyên liệu 2 phút |
| `checkout` | Thanh toán mô phỏng, idempotency, hết hạn, hoàn giữ chỗ |
| `auth`, `rewards`, `promotions` | Tài khoản JWT, điểm và mã giảm giá |
| `admin` | Đơn, khuyến mãi, API chỉ đọc nguyên liệu/công thức |

Nguồn schema là [schema.prisma](prisma/schema.prisma). Đơn mới dùng `Ingredient.onHand/reserved`; `Product.stock` chỉ còn hỗ trợ đơn `LEGACY`. API ghi để quản lý nguyên liệu và công thức chưa hoàn thành.

## Kiểm tra mã nguồn

Chạy trong thư mục `backend` với Node 22 và dependency từ `npm ci`:

```powershell
npx prisma generate
npm run lint
npm run build
npm test
```

Các lệnh trên là bước CI, không tạo dữ liệu. `npm run test:ingredients` là test tích hợp dùng **DB thử riêng**; cách thiết lập và bảo vệ DB nằm trong [README gốc](../README.md). API chạy local trực tiếp bằng `npm run start:dev` chỉ khi đã cấu hình `backend/.env` và không chạy đồng thời container `api` cùng cổng 3001.

## Email OTP ở local và trên Render

`EmailService` chọn cách gửi bằng `MAIL_PROVIDER`. Mặc định là `smtp`, nên `.env` và Compose local hiện có tiếp tục dùng `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`. SMTP cổng 587 dùng STARTTLS, cổng 465 dùng TLS ngay khi kết nối. Tham khảo [.env.example](.env.example) khi tạo môi trường local mới; không ghi đè file `.env` đang dùng.

Trên Render Free, đặt các biến sau trong environment của **API**:

```dotenv
MAIL_PROVIDER=brevo
BREVO_API_KEY=<Brevo API key>
BREVO_SENDER_EMAIL=<sender đã xác minh trong Brevo>
BREVO_SENDER_NAME=BrewLite
```

Đăng ký Brevo và xác minh sender trước khi gửi tới người nhận. Dùng API key cho REST API, không dùng SMTP key. Dịch vụ gọi cố định `https://api.brevo.com/v3/smtp/email` qua HTTPS với timeout 10 giây; không cần thêm SDK. Cấu hình thiếu key/sender hoặc sai provider sẽ khiến API dừng lúc khởi động. Xem [API gửi email](https://developers.brevo.com/reference/send-transac-email), [yêu cầu sender](https://developers.brevo.com/docs/getting-started-with-senders-and-domains) và [.env.production.example](.env.production.example) cho các biến deploy còn lại. File `.env.production` trên máy hiện chỉ được các công cụ DB đọc; NestJS vẫn đọc `.env` và biến môi trường của hosting.

Đăng ký, gửi lại OTP và quên mật khẩu chỉ báo gửi thành công khi provider chấp nhận email. Nếu gửi lỗi, API trả `503` với `code: EMAIL_DELIVERY_FAILED`; việc provider chấp nhận chưa bảo đảm email đã vào inbox, cần kiểm tra log gửi thư của Brevo. Tài khoản đã tạo vẫn ở trạng thái chưa xác minh: đăng nhập bằng mật khẩu đã đăng ký, chọn xác minh email rồi gửi lại mã (giữ thời gian chờ 60 giây). API không ghi OTP, key hoặc nội dung lỗi từ provider vào log. Đăng nhập tài khoản đã xác minh, JWT và phân quyền giữ nguyên.

## Database Supabase và local

Local tiếp tục dùng `backend/.env` và PostgreSQL Docker. Cấu hình thao tác DB cloud nằm riêng trong `backend/.env.production`, được Git bỏ qua. Điền `DATABASE_URL` bằng URI Supabase **Session pooler**, cổng **5432**, có `sslmode=require`; mật khẩu trong URI phải được URL-encode.

Chạy từ thư mục `backend`:

```powershell
node scripts/supabase-db.mjs status
node scripts/supabase-db.mjs migrate
node scripts/supabase-db.mjs secure
```

`status` chỉ đọc trạng thái bảng, migration và quyền truy cập. `migrate` áp migration vào DB cloud; nó dừng nếu phát hiện bảng có sẵn nhưng chưa có lịch sử Prisma. `secure` chỉ áp dụng khi public schema có đúng 16 bảng BrewLite hiện tại: bật RLS, thu hồi quyền bảng của `PUBLIC`/`anon`/`authenticated`, và bỏ grant mặc định cho hai role Data API khi `postgres` tạo bảng mới. NestJS truy cập bằng database owner vẫn dùng được; frontend gọi API NestJS. Khi thêm bảng mới, kiểm tra lại quyền trước khi đưa dữ liệu lên.

Các lệnh này không seed và không đồng bộ dữ liệu local/cloud. Khi deploy API, cấu hình `DATABASE_URL` trong environment của dịch vụ hosting; NestJS hiện không tự đọc `.env.production`. File đó chỉ phục vụ công cụ thao tác DB cloud trên máy phát triển.

Để chuyển một bản dữ liệu local lên Supabase mới, dùng công cụ riêng sau khi tạo schema và khóa quyền truy cập:

```powershell
node scripts/copy-local-to-supabase.mjs inspect
node scripts/copy-local-to-supabase.mjs copy --pg-bin 'D:\User\PostgreSQL\bin'
```

Thay `--pg-bin` bằng thư mục cài PostgreSQL client tools trên máy, hoặc bỏ tùy chọn nếu `pg_dump`, `pg_restore`, `psql` đã có trong PATH. Công cụ chỉ nhận nguồn local `localhost`/`127.0.0.1:5433/brewlite` và đích Supabase Session pooler. Nó kiểm tra cột theo tên/kiểu, enum, ràng buộc và migration; thứ tự vật lý cột có thể khác. Checksum migration local có thể khác sau quá trình baseline, nhưng tên migration phải khớp và checksum phía cloud phải khớp repository; lịch sử migration của mỗi DB được giữ riêng.

Lệnh `copy` tạo archive schema/data của public schema và manifest trong `.backups/` (được Git bỏ qua), cùng một snapshot đọc nhất quán. Chỉ dữ liệu 15 bảng nghiệp vụ được nhập lên cloud; không nhập `_prisma_migrations`. Đích phải trống, các bảng được khóa và kiểm tra lại trong transaction nhập. Số bản ghi và checksum nội dung phải khớp snapshot trước khi commit, rồi được kiểm tra lại sau commit. Bản sao lưu chứa dữ liệu tài khoản, chỉ giữ tại máy. Công cụ không seed, ghi đè dữ liệu cloud có sẵn, hoặc sửa dữ liệu local. Đây là thao tác sao chép một lần; các thay đổi tiếp theo ở local/cloud không tự đồng bộ.
