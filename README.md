# BrewLite — Assignment 1

BrewLite là ứng dụng đặt đồ uống và thanh toán không tiền mặt của nhóm môn Công nghệ Phần mềm, Trường Đại học Sài Gòn. **Repository này là bản Assignment 1 chạy local**. Bản triển khai trên Vercel, Render và Supabase thuộc [repository Assignment 2](https://github.com/PhucTruong11/brewlite-assignment2); không cần cấu hình các dịch vụ đó để chạy bản này.

![Công nghệ và luồng kết nối local của BrewLite](docs/assets/tech-stack-flow.svg)

## Chức năng và luồng chính

- Menu có **6 đồ uống, 3 topping**; khách chọn size S/M/L và thêm món vào giỏ.
- Giỏ hàng gộp những món có cùng sản phẩm, size và topping. `POST /api/cart/validate` tính lại giá và đối chiếu công thức với lượng nguyên liệu còn có thể dùng trong PostgreSQL. Thao tác trong giỏ **chưa trừ tồn kho**.
- Khi khách đã đăng nhập bấm **Tiến hành thanh toán**, `POST /api/orders` kiểm tra lại giỏ trong transaction, giữ nguyên liệu (`reserved`), tạo đơn `PENDING` và trả `orderId`. Mỗi đơn có **2 phút** để thanh toán.
- Trang checkout hiển thị QR VietQR/SePay hoặc phương thức thẻ mô phỏng. Thanh toán thành công chuyển đơn sang `PAID`, trừ `onHand` và giải phóng phần `reserved`; thao tác thanh toán dùng `Idempotency-Key` để tránh ghi nhận lặp. QR cần webhook SePay cấu hình đúng để tự xác nhận. Nút **Test nhanh** dành cho demo local.
- Đơn hết hạn được hủy và trả nguyên liệu đã giữ. Khách có thể tạo lại **một lần** trong 2 phút tiếp theo; lần này là đơn mới với `orderId` mới và phải kiểm tra lại tồn.
- Khách xem đơn và lịch sử; admin quản lý trạng thái đơn, voucher, nguyên liệu và công thức. Backend đã có API đọc/ghi nguyên liệu, công thức. Giao diện admin có các thao tác tương ứng, nhưng cần kiểm thử tích hợp từng thao tác trước khi demo.
- Chuông cạnh **Giỏ hàng** hiển thị cập nhật đơn. Nếu admin hủy đơn đã thanh toán trước khi pha chế, khách nhận giá trị đã trả để chọn đơn thay thế.

User Story, tiêu chí chấp nhận và phân công của nhóm nằm trong [nguồn LaTeX Assignment 1](docs/assignment1-user-stories/).

## Cấu trúc repository

```text
brewlite/
├── frontend/                 Next.js, React, Zustand, TanStack Query
├── backend/                  NestJS, Prisma, PostgreSQL
│   ├── prisma/               Schema, migrations, seed và dữ liệu mẫu
│   └── scripts/              Kiểm thử nghiệp vụ nguyên liệu/thanh toán
├── docker/                   Compose cho db, api, web và hướng dẫn vận hành
├── tests/                    Collection Postman/Newman và Thunder Client
├── docs/assignment1-user-stories/  Nguồn LaTeX của Assignment 1
└── .github/workflows/ci.yml  Lint, build và unit test khi mở PR vào main
```

## Chạy toàn bộ bằng Docker Compose

Yêu cầu: Docker Desktop có Compose, các cổng **3000**, **3001**, **5433** còn trống. Chạy PowerShell tại **thư mục gốc repository**. Tạo `backend/.env` với tối thiểu:

```dotenv
DATABASE_URL=postgresql://brewlite:brewlite@localhost:5433/brewlite
PORT=3001
FRONTEND_URL=http://localhost:3000
JWT_SECRET=thay-bang-chuoi-ngau-nhien-du-dai
```

Compose ghi đè `DATABASE_URL` thành `db:5432` bên trong container. Nếu dùng xác minh email, thêm `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` vào `backend/.env`. Muốn nhận thanh toán QR tự động, cần cấu hình `SEPAY_API_KEY`, `SEPAY_BANK_NAME`, `SEPAY_ACCOUNT_NO`, `SEPAY_ACCOUNT_NAME` và webhook trỏ đến API có thể truy cập công khai. **Không commit `.env` hay khóa thật.**

```powershell
$brewCompose = @('-f', '.\docker\docker-compose.dev.yml', '-f', '.\docker\docker-compose.app.yml')
docker compose @brewCompose config --quiet
docker compose @brewCompose build api
docker compose @brewCompose build web
docker compose @brewCompose up -d --wait db
```

**Chỉ với DB mới, chưa có bảng và dữ liệu**, chạy một lần:

```powershell
docker compose @brewCompose run --rm --no-deps api npx prisma migrate deploy
docker compose @brewCompose run --rm --no-deps api npx prisma db seed
docker compose @brewCompose run --rm --no-deps api npm run catalog:bootstrap
docker compose @brewCompose run --rm --no-deps api npm run inventory:demo-stock
```

`seed` tạo danh mục 6 món và 3 topping. `catalog:bootstrap` tạo nguyên liệu/công thức mẫu. `inventory:demo-stock` chỉ nạp nguyên liệu đang có tồn bằng 0 cho **DB demo**; bỏ lệnh này nếu 0 là trạng thái hết hàng có chủ ý. **Không chạy lại seed trên DB đã dùng** và không dùng `down -v` nếu muốn giữ đơn hàng.

Sau đó bật đủ ba dịch vụ:

```powershell
docker compose @brewCompose up -d --wait
docker compose @brewCompose ps
```

Mở [web local](http://localhost:3000), [menu qua web](http://localhost:3000/api/products) hoặc [API trực tiếp](http://localhost:3001/api/products). Web chuyển tiếp `/api` đến API; API kết nối DB qua mạng Compose. PostgreSQL dùng volume `docker_brewlite_pgdata` và được mở trên máy ở `localhost:5433`.

**Máy đã có DB:** sao lưu trước khi áp migration mới; chỉ chạy `npx prisma migrate deploy`, không seed lại. Nếu DB cũ có bảng nhưng chưa có lịch sử Prisma Migrate, đọc nhánh **DB cũ** trong [docker/README.md](docker/README.md) trước khi chạy. Sau khi pull code mới, build lại image đã thay đổi rồi `up -d --wait`. Hướng dẫn dừng, bật, xem log và xử lý DB cũ nằm trong [docker/README.md](docker/README.md).

## Chạy trực tiếp bằng Node.js

Yêu cầu Node.js 22, npm và PostgreSQL đang chạy. Có thể chỉ bật DB bằng Docker:

```powershell
docker compose -f .\docker\docker-compose.dev.yml up -d --wait db
```

Trong `backend/.env`, dùng `DATABASE_URL` trỏ tới `localhost:5433` như trên. Tạo `frontend/.env.local`:

```dotenv
NEXT_PUBLIC_API_URL=/api
API_INTERNAL_URL=http://localhost:3001
```

Mở **hai terminal**:

```powershell
# Terminal backend
cd backend
npm ci
npx prisma generate
npm run start:dev
```

```powershell
# Terminal frontend
cd frontend
npm ci
npm run dev
```

Nếu DB mới, chạy phần migration/seed ở trên với Compose trước khi khởi động hai app. Không bật container `api`/`web` đồng thời với tiến trình Node ở cùng cổng.

## Kiểm thử đền bù đơn bị hủy

Khi chạy local, nút **Test nhanh** mô phỏng thanh toán, không cần tài khoản hoặc khóa PayOS. API vẫn xử lý trừ kho và cộng điểm như một giao dịch thành công.

Hai script `node tests/test_race_condition.js` (từ thư mục repo) và `npx tsx scripts/simulate-payos.ts` (từ `backend`) chạy bằng fixture tự dọn trong DB riêng `brewlite_test` trên localhost:5433. DB test cần được tạo và áp migrations trước; các script không ghi đè kho hoặc tạo đơn giả trong DB `brewlite` đang dùng.

Áp migration `20261110000200_order_compensation` và chạy lại API/web đã build. Dùng hai phiên trình duyệt riêng cho khách và admin.

1. Khách đặt một đơn và hoàn tất thanh toán thẻ mô phỏng. Admin vào **Quản trị → Đơn hàng → Cần xử lý**, chọn **Hủy đơn** khi đơn chưa được pha chế.
2. Từ chuông hoặc **Lịch sử → Chi tiết đơn**, khách mở **Chọn món thay thế**. Giá trị đền bù bằng toàn bộ giá trị món nước của đơn gốc (bảo lưu trọn vẹn quyền lợi mã giảm giá cho khách, đồng thời hoàn lại voucher vào ví nếu đơn có dùng voucher đổi điểm).
3. Đơn đồng giá vào hàng đợi ngay. Đơn rẻ hơn cần thêm món hoặc topping. Với đơn đắt hơn, khách có 5 phút để quét mã VietQR ngay trên trang BrewLite và thanh toán phần chênh lệch qua PayOS. Đơn vào hàng đợi sau khi giao dịch được xác nhận.
4. Để kiểm tra lần thử hết hạn, tạo mã QR rồi để qua thời hạn giữ đơn. Sau khi PayOS xác nhận link hết hạn hoặc đã hủy và chưa nhận tiền, khách có thể chọn lại.

Ca trả thêm trực tiếp cần `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` và webhook công khai `/api/payments/payos-webhook`. Để chạy kiểm thử với PayOS giả lập, đặt `E2E_DATABASE=1`, trỏ `DATABASE_URL` tới PostgreSQL `brewlite_test` trên localhost, áp migrations rồi chạy lệnh sau trong `backend`.

```powershell
npm run test:e2e -- test/order-compensation.e2e-spec.ts
```

## Kiểm thử Assignment 1

Chạy lệnh trong đúng thư mục; CI thực hiện lint, build và unit test cho cả hai ứng dụng khi mở PR vào `main`.

| Thư mục | Lệnh | Kiểm tra |
| --- | --- | --- |
| `backend` | `npm run lint` | Oxlint |
| `backend` | `npm run build` | Biên dịch NestJS |
| `backend` | `npm test` | Unit test |
| `backend` | `npm run test:e2e` | Test HTTP mẫu, cần DB local |
| `frontend` | `npm run lint` | ESLint |
| `frontend` | `npm run build` | Build Next.js; cần tải font Geist từ Google |
| `frontend` | `npm test` | Unit test |

`backend/scripts/test-ingredient-flow.ts` (`npm run test:ingredients`) kiểm tra giỏ, giữ/trừ/trả nguyên liệu, đơn đồng thời và idempotency. Script này **ghi và đặt lại dữ liệu**, chỉ chạy với DB thử riêng tên `brewlite_inventory_test`. Lần đầu tạo DB thử, áp migration và seed; sau đó chạy script trong `backend`:

```powershell
docker exec brewlite-db psql -U brewlite -d postgres -c 'CREATE DATABASE brewlite_inventory_test'
cd backend
$env:DATABASE_URL = 'postgresql://brewlite:brewlite@localhost:5433/brewlite_inventory_test'
npx prisma migrate deploy
npx prisma db seed
npm run catalog:bootstrap
npm run test:ingredients
Remove-Item Env:DATABASE_URL
```

Nếu DB thử đã có, bỏ lệnh `CREATE DATABASE` và không seed lại. Collection trong `tests/` cũng có request tạo đơn/thanh toán và sẽ ghi dữ liệu; dùng DB thử khi chạy toàn bộ Newman/Thunder Client.

Kiểm tra nhanh không tạo đơn:

```powershell
Invoke-WebRequest 'http://localhost:3000/api/products' | Select-Object StatusCode
docker compose @brewCompose ps
docker compose @brewCompose logs --tail=100 api web
```

## Tài liệu

| Tài liệu | Nội dung |
| --- | --- |
| [docker/README.md](docker/README.md) | Cài đặt và vận hành Compose chi tiết |
| [docs/assignment1-user-stories/](docs/assignment1-user-stories/) | User Story, tiêu chí chấp nhận và phân công bằng LaTeX |
| [backend/prisma/schema.prisma](backend/prisma/schema.prisma) | Schema PostgreSQL qua Prisma |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | CI của repository |

Bản Assignment 2 có quy trình triển khai và tài liệu riêng trong repository của Assignment 2.
