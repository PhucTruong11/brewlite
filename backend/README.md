# BrewLite API

API NestJS cho menu, xác thực, giỏ/kiểm tra nguyên liệu, tạo đơn, checkout mô phỏng, điểm thưởng và admin. Hướng dẫn **chạy cả hệ thống** và xử lý DB nằm ở [README gốc](../README.md) và [Docker README](../docker/README.md). Dùng các tài liệu đó khi mới pull code; không chạy seed trên DB đã có đơn.

## Local và bản deploy

Project chạy được theo cả hai cách. Việc deploy không thay kết nối DB hoặc cấu hình SMTP của môi trường local.

| Thành phần | Local: Node trực tiếp | Local: Docker Compose | Bản deploy HTTPS |
| --- | --- | --- | --- |
| Frontend | `http://localhost:3000` | `http://localhost:3000` | [Vercel](https://brewlite-frontend.vercel.app/) |
| Trang admin | `http://localhost:3000/admin` | `http://localhost:3000/admin` | [Admin](https://brewlite-frontend.vercel.app/admin) |
| API | `http://localhost:3001/api` | Cùng API; web chuyển tiếp tới `http://api:3001` | [Render API](https://brewlite-api-omni.onrender.com/api) |
| Database | Docker PostgreSQL qua `localhost:5433` | PostgreSQL qua `db:5432` | Supabase Session pooler qua TLS |
| Gửi OTP | SMTP (`MAIL_PROVIDER=smtp`, cũng là mặc định) | SMTP từ `backend/.env` | Brevo HTTPS API (`MAIL_PROVIDER=brevo`) |

**DB local và Supabase độc lập.** Bản dữ liệu local đã được sao chép một lần lên cloud; đăng ký, đặt đơn, sửa tồn kho hoặc đổi mật khẩu sau đó chỉ ảnh hưởng DB mà API đang kết nối. Push/merge code và redeploy không đồng bộ dữ liệu giữa hai DB. Tài khoản mới tạo trên local không tự có trên bản deploy, và ngược lại.

### Chạy local

Nếu DB đã được chuẩn bị theo [Docker README](../docker/README.md), chạy tại **thư mục gốc repository**:

```powershell
docker compose up -d --build --wait
docker compose ps
```

Mở `http://localhost:3000`; kiểm tra menu qua `http://localhost:3000/api/products`. Lần đầu dùng DB trống cần làm migration và khởi tạo dữ liệu theo Docker README trước. DB đang có dữ liệu không chạy seed lại hoặc xóa volume.

Nếu muốn chạy Node trực tiếp, chỉ bật DB Docker, cấu hình `backend/.env` từ [.env.example](.env.example), rồi chạy `npm run start:dev` trong `backend` và `npm run dev` trong `frontend` ở hai terminal. Frontend local đặt `NEXT_PUBLIC_API_URL=http://localhost:3001/api` trong `frontend/.env.local`. Dừng container web/API trước để tránh tranh cổng. Compose vẫn ghi đè DB thành `db:5432` khi chạy toàn bộ bằng container.

### Cấu hình bản deploy

Render chỉ build Dockerfile của **backend**, không chạy Compose hoặc tạo PostgreSQL container. Dùng Root Directory `backend`, Dockerfile `./Dockerfile`, Build Context `.`, instance Free, Health Check Path `/api/products`. Sau khi merge PR, đặt branch Render theo `main`; frontend Vercel cũng dùng production branch `main`, Root Directory `frontend` và preset Next.js. Cấu hình chi tiết nằm ở [README gốc](../README.md).

API lấy `DATABASE_URL`, `NODE_ENV=production`, `FRONTEND_URL=https://brewlite-frontend.vercel.app`, `JWT_SECRET` và các biến Brevo từ environment của Render. Render cung cấp `PORT`. Mẫu biến không chứa secret thật nằm trong [.env.production.example](.env.production.example).

Frontend Vercel chỉ cần hai biến Production sau, rồi **redeploy frontend** sau mỗi lần đổi giá trị:

```dotenv
NEXT_PUBLIC_API_URL=/api
API_INTERNAL_URL=https://brewlite-api-omni.onrender.com
```

Trình duyệt gọi `/api` trên domain Vercel, Next.js chuyển tiếp tới Render. Không đưa `DATABASE_URL`, `JWT_SECRET` hay Brevo key vào frontend. Cookie đăng nhập production dùng `HttpOnly`, `Secure`, `SameSite=Lax`; giữ đường đi qua proxy này thay vì đổi frontend sang gọi trực tiếp domain Render.

### Kiểm tra production ngày 03/11/2026

Trang chủ/admin Vercel, `GET /api` trên Render và `GET /api/products` qua cả Render/Vercel đều trả 200; hai endpoint menu cùng trả 6 món. Đăng nhập admin qua Vercel trả 200, cookie có đủ ba thuộc tính trên; `GET /api/auth/me` và `GET /api/admin/orders/counts` bằng phiên đăng nhập trả 200. Endpoint admin trả 401 nếu chưa đăng nhập; đăng xuất trả 200. Kiểm tra này không tạo đơn, thay tồn kho hoặc gửi email OTP thật.

Render Free có thể ngủ sau 15 phút không có traffic; request đầu sau đó có thể mất khoảng một phút để đánh thức API. Cron trong tiến trình NestJS không chạy khi instance ngủ, nên không bảo đảm xử lý đơn hết hạn liên tục khi dùng gói Free. Xem [giới hạn Render Free](https://render.com/docs/free).

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

Đăng ký Brevo và xác minh sender trước khi gửi tới người nhận. Dùng API key cho REST API, không dùng SMTP key. Dịch vụ gọi cố định `https://api.brevo.com/v3/smtp/email` qua HTTPS với timeout 10 giây; không cần thêm SDK. Cấu hình thiếu key/sender hoặc sai provider sẽ khiến API dừng lúc khởi động. Xem [API gửi email](https://developers.brevo.com/reference/send-transac-email), [yêu cầu sender](https://developers.brevo.com/docs/getting-started-with-senders-and-domains) và [.env.production.example](.env.production.example) cho các biến deploy còn lại. Script `node scripts/check-brevo.mjs` đọc `.env.production` để kiểm tra key, sender và quyền gửi bằng API chỉ đọc; không gửi email. NestJS vẫn đọc `.env` và biến môi trường của hosting, không tự đọc `.env.production`.

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

Các lệnh này không seed và không đồng bộ dữ liệu local/cloud. Khi deploy API, cấu hình `DATABASE_URL` trong environment của dịch vụ hosting; NestJS hiện không tự đọc `.env.production`. File đó phục vụ các script thao tác DB cloud và kiểm tra Brevo trên máy phát triển. File chứa secret thật được Git và Docker build context bỏ qua; chỉ commit các file `.example` với giá trị mẫu.

Để chuyển một bản dữ liệu local lên Supabase mới, dùng công cụ riêng sau khi tạo schema và khóa quyền truy cập:

```powershell
node scripts/copy-local-to-supabase.mjs inspect
node scripts/copy-local-to-supabase.mjs copy --pg-bin 'D:\User\PostgreSQL\bin'
```

Thay `--pg-bin` bằng thư mục cài PostgreSQL client tools trên máy, hoặc bỏ tùy chọn nếu `pg_dump`, `pg_restore`, `psql` đã có trong PATH. Công cụ chỉ nhận nguồn local `localhost`/`127.0.0.1:5433/brewlite` và đích Supabase Session pooler. Nó kiểm tra cột theo tên/kiểu, enum, ràng buộc và migration; thứ tự vật lý cột có thể khác. Checksum migration local có thể khác sau quá trình baseline, nhưng tên migration phải khớp và checksum phía cloud phải khớp repository; lịch sử migration của mỗi DB được giữ riêng.

Lệnh `copy` tạo archive schema/data của public schema và manifest trong `.backups/` (được Git bỏ qua), cùng một snapshot đọc nhất quán. Chỉ dữ liệu 15 bảng nghiệp vụ được nhập lên cloud; không nhập `_prisma_migrations`. Đích phải trống, các bảng được khóa và kiểm tra lại trong transaction nhập. Số bản ghi và checksum nội dung phải khớp snapshot trước khi commit, rồi được kiểm tra lại sau commit. Bản sao lưu chứa dữ liệu tài khoản, chỉ giữ tại máy. Công cụ không seed, ghi đè dữ liệu cloud có sẵn, hoặc sửa dữ liệu local. Đây là thao tác sao chép một lần; các thay đổi tiếp theo ở local/cloud không tự đồng bộ.
