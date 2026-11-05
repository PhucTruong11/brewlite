# Docker cho BrewLite

Hướng dẫn chạy BrewLite Assignment 1 local bằng Docker Compose. Mở PowerShell tại thư mục gốc `brewlite` chứa `frontend`, `backend` và `docker`; cách khởi động ngắn gọn nằm trong [README chính](../README.md).

Ba dịch vụ đã có cấu hình thực tế: `db` (PostgreSQL 16), `api` (NestJS) và `web` (Next.js). `docker-compose.dev.yml` chứa DB; `docker-compose.app.yml` bổ sung API và web. Hai Dockerfile nằm trong `backend/` và `frontend/`. Đây là môi trường phát triển/demo local, chưa phải cấu hình production.

## 1. Chuẩn bị

- Sau khi thay đổi được commit, push và merge vào `main`, chạy `git switch main` rồi `git pull origin main`. Docker image và dữ liệu DB không đi theo Git; mỗi máy cần build image và chuẩn bị DB riêng.
- Docker Desktop và Docker Compose đang chạy; cổng 3000, 3001 và 5433 chưa được tiến trình khác dùng.
- Có `backend/.env` với `JWT_SECRET` riêng. Nếu cần đăng ký/xác minh email, cấu hình thêm SMTP theo [README chính](../README.md). Compose ghi đè `DATABASE_URL` thành `db:5432`; `backend/.env` có thể tiếp tục dùng `localhost:5433` khi chạy Node trực tiếp trên Windows.
- Khi `MAIL_FROM` chứa tên hiển thị và dấu cách, đặt toàn bộ giá trị trong dấu nháy kép, ví dụ `MAIL_FROM="BrewLite Coffee <sender@example.com>"`, để Compose đọc đúng.
- Dừng frontend/backend đang chạy bằng Node trực tiếp trước khi bật container, tránh trùng cổng. Không commit `backend/.env`.

Trong mỗi cửa sổ PowerShell mới, khai báo lại biến sau tại thư mục gốc `brewlite`:

```powershell
$brewCompose = @('-f', '.\docker\docker-compose.dev.yml', '-f', '.\docker\docker-compose.app.yml')
docker compose @brewCompose config --quiet
docker compose @brewCompose config --services
```

Danh sách dịch vụ phải có `db`, `api`, `web`. Dùng `config --quiet` để tránh in biến môi trường trong terminal.

## 2. Build và chạy cả hệ thống

Build riêng từng image để dễ đọc lỗi và giảm tải tài nguyên khi build, rồi bật DB:

```powershell
docker compose @brewCompose build api
docker compose @brewCompose build web
docker compose @brewCompose up -d --wait db
```

**DB mới, chưa có bảng**, tạo schema sau khi DB đã healthy:

```powershell
docker compose @brewCompose run --rm --no-deps api npx prisma migrate deploy
```

Sau đó, chỉ trên DB trống, nạp dữ liệu mẫu:

```powershell
docker compose @brewCompose run --rm --no-deps api npx prisma db seed
docker compose @brewCompose run --rm --no-deps api npm run catalog:bootstrap
docker compose @brewCompose run --rm --no-deps api npm run inventory:demo-stock
```

Seed từ chối chạy nếu DB đã có dữ liệu và chỉ tạo 6 món/3 topping. Không chạy seed mỗi lần bật hệ thống. `catalog:bootstrap` tạo 17 nguyên liệu, công thức mẫu và bật bán 6 món/3 topping; nó không reset stock hoặc xóa đơn. Checkout mới dùng tồn nguyên liệu. `inventory:demo-stock` chỉ nạp lượng mẫu cho các nguyên liệu có tồn bằng 0 trong DB demo local; không chạy nếu số 0 là trạng thái hết hàng có chủ ý.

**DB cũ có bảng/dữ liệu nhưng chưa có lịch sử Prisma Migrate:** sao lưu DB, rồi đánh dấu baseline một lần trước khi deploy. Không chạy `db seed` trên DB này:

```powershell
docker compose @brewCompose run --rm --no-deps api npx prisma migrate resolve --applied 20261027000100_baseline
docker compose @brewCompose run --rm --no-deps api npx prisma migrate deploy
docker compose @brewCompose run --rm --no-deps api npm run catalog:bootstrap
```

Nếu DB đã có baseline, bỏ lệnh `resolve`; lần pull sau có migration mới chỉ chạy `migrate deploy`. Chỉ dùng `resolve` sau khi đã xác minh và sao lưu DB cũ. Mô hình dữ liệu được khai báo trong [Prisma schema](../backend/prisma/schema.prisma).

Sau đó bật đủ ba dịch vụ:

```powershell
docker compose @brewCompose up -d --wait
docker compose @brewCompose ps
```

`--wait` chỉ thành công khi DB, API và web đạt healthcheck. Mở [web](http://localhost:3000), kiểm tra [menu qua web](http://localhost:3000/api/products) hoặc [API trực tiếp](http://localhost:3001/api/products). API được publish trên `127.0.0.1:3001`, còn web trên cổng `3000`.

## 3. Luồng kết nối và kiểm tra

Trình duyệt gọi `/api` trên web. Next.js chuyển tiếp tới `api:3001`; NestJS kết nối PostgreSQL qua `db:5432`. Compose truyền `NEXT_PUBLIC_API_URL=/api` và `API_INTERNAL_URL=http://api:3001` vào lúc build web. Thay đổi các biến này cần build lại image web. Backend dùng `NODE_ENV=development` để cookie hoạt động trong demo HTTP local.

```powershell
Invoke-WebRequest 'http://localhost:3000' | Select-Object StatusCode
Invoke-WebRequest 'http://localhost:3000/api/products' | Select-Object StatusCode
docker compose @brewCompose ps
docker compose @brewCompose logs --tail=100 api web
docker compose @brewCompose stats --no-stream
```

Healthcheck API hiện gọi `/api/products` để kiểm tra cả truy cập DB; chưa có endpoint `/health` chuyên dụng. `/health` không phải đường dẫn kiểm tra hiện tại.

Build lại sau khi sửa code hoặc dependency, rồi cập nhật container tương ứng:

```powershell
docker compose @brewCompose build api
docker compose @brewCompose up -d --wait api

docker compose @brewCompose build web
docker compose @brewCompose up -d --wait web
```

### Thành viên đã chạy bản cũ và muốn cập nhật code mới

Sau khi code được merge, mở PowerShell ở **thư mục gốc bản clone trên máy mình**. Giữ nguyên `backend/.env` và volume DB đang dùng. Thứ tự dưới đây áp migration trước khi API mới chạy. Nếu đang làm trên nhánh cá nhân, merge `main` vào nhánh đó theo quy trình Git của nhóm rồi mới build; không ghi đè thay đổi chưa commit.

```powershell
git switch main
git pull origin main
$brewCompose = @('-f', '.\docker\docker-compose.dev.yml', '-f', '.\docker\docker-compose.app.yml')
docker compose @brewCompose config --quiet
docker compose @brewCompose up -d --wait db
docker compose @brewCompose build api
docker compose @brewCompose run --rm --no-deps api npx prisma migrate deploy
docker compose @brewCompose run --rm --no-deps api npx prisma migrate status
docker compose @brewCompose build web
docker compose @brewCompose up -d --wait
docker compose @brewCompose ps
```

Không chạy lại `db seed`: seed chỉ dành cho DB trống. Migration `20261029000100_prune_legacy_catalog` xóa 17 món và 12 topping cũ, giữ tên/ảnh món trong lịch sử đơn; sao lưu DB trước khi áp trên máy của mỗi thành viên. Chỉ chạy `catalog:bootstrap` một lần khi chuyển DB sang danh mục nguyên liệu; script không reset đơn/tồn nhưng bật lại 6 món và 3 topping mẫu. `inventory:demo-stock` chỉ dành cho DB demo muốn nạp nguyên liệu đang có tồn 0. Nếu DB cũ chưa từng dùng Prisma Migrate, làm theo nhánh baseline ở phần 2 sau khi sao lưu. Admin xem và quản lý dữ liệu ở `/admin/ingredients` và `/admin/recipes`; backend đã có API đọc/ghi, nhưng cần kiểm thử tích hợp từng thao tác giao diện trước khi demo.

Với DB lần đầu chuyển sang nguyên liệu, chèn hai lệnh sau sau `migrate deploy` trong khối trên. Chỉ dùng lệnh nạp tồn thứ hai cho DB demo, khi nguyên liệu tồn 0 chưa phải trạng thái hết hàng có chủ ý:

```powershell
docker compose @brewCompose run --rm --no-deps api npm run catalog:bootstrap
docker compose @brewCompose run --rm --no-deps api npm run inventory:demo-stock
```

Nếu cần log build chi tiết, dùng `docker compose --progress plain @brewCompose build api` hoặc thay `api` bằng `web`. `npm ci` yêu cầu `package.json` và `package-lock.json` đồng bộ. Lỗi thiếu TypeScript 5.9.3 trong lockfile backend đã được sửa ngày 22/10/2026; nếu lỗi tương tự tái xuất hiện sau khi đổi dependency, cập nhật lockfile bằng npm tương ứng với Node 22 rồi kiểm tra diff trước khi build lại.

## 4. Dùng hằng ngày và giữ dữ liệu

Các lệnh dưới đây dùng `$brewCompose` ở phần 1:

```powershell
docker compose @brewCompose ps -a
docker compose @brewCompose stop web api
docker compose @brewCompose stop
docker compose @brewCompose up -d --wait
```

`stop` giữ container và volume. Không dùng `down -v` hoặc xóa volume nếu cần giữ dữ liệu đơn hàng/menu.

Nếu chỉ muốn quản lý DB khi web/API chạy trực tiếp bằng Node, dùng một file Compose:

```powershell
Set-Location 'D:\Dev\Subject_Uni\SWE\brewlite'
docker compose -f .\docker\docker-compose.dev.yml ps
docker compose -f .\docker\docker-compose.dev.yml stop db
docker compose -f .\docker\docker-compose.dev.yml up -d db
```

DB dùng container `brewlite-db`, cổng host `5433`, volume cố định `docker_brewlite_pgdata`. Dừng DB riêng sẽ làm API mất kết nối. Các container DB/API/web lần lượt có trần RAM 512 MiB mỗi dịch vụ; theo dõi thực tế bằng `docker compose @brewCompose stats --no-stream`.

## 5. Demo trên hai laptop

Chạy Compose trên một laptop làm máy chủ. Laptop còn lại cùng mạng mở `http://<IP-LAN-máy-chủ>:3000`; cho phép cổng 3000 qua firewall mạng riêng khi cần. Trình duyệt dùng `/api` qua web, nên không cần mở cổng API hoặc chạy DB thứ hai. Hai laptop đăng nhập user/admin bằng hai phiên riêng.

## 6. Lỗi thường gặp và giới hạn hiện tại

| Hiện tượng | Kiểm tra |
| --- | --- |
| `config` báo sai kiểu `secrets.api.environment` | File `docker-compose.app.yml` phải bắt đầu bằng `services:`, không phải `secrets:` |
| `config` báo lỗi ở `MAIL_FROM` | Đặt cả tên hiển thị và email trong cùng một cặp dấu nháy kép trong `backend/.env` |
| `npm ci` báo lockfile lệch | Đồng bộ lockfile với `package.json` bằng npm phù hợp Node 22, rồi build lại image |
| Cổng 3000/3001 đã được dùng | Dừng web/API local đang chạy hoặc container cũ trước khi `up` |
| API không kết nối DB | Kiểm tra DB healthy và `DATABASE_URL` nội bộ dùng `db:5432` |
| API báo thiếu bảng/cột | Kiểm tra `npx prisma migrate status`, áp `migrate deploy` bằng image API mới; không dùng `db push` để bỏ qua lịch sử migration |
| Web không gọi được API | Kiểm tra `NEXT_PUBLIC_API_URL=/api`, `API_INTERNAL_URL=http://api:3001`, rồi build lại web |
| Build web lỗi tải font Geist | Kiểm tra kết nối mạng/DNS của Docker tại thời điểm build |
| Container bị dừng | Xem `logs`, `ps -a` và `stats` để phân biệt lỗi ứng dụng với thiếu tài nguyên |

Luồng giỏ, tạo đơn và payments dùng nguyên liệu; hai trang admin đã kết nối API nguyên liệu/công thức. `POST /api/cart/validate` kiểm tra toàn bộ giỏ và không trừ tồn.
