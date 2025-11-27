# Giai đoạn 1: Build
FROM node:18-alpine as builder

# Nhận biến BASE_PATH từ docker build-args (được truyền từ GitHub Actions)
# Dùng để cấu hình đường dẫn tương đối hoặc base href cho Vite
ARG BASE_PATH=/vg-rag

WORKDIR /app

# Copy package files để tận dụng cache layer
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Build dự án
# Lưu ý: Cần đảm bảo vite.config.ts sử dụng process.env.BASE_PATH hoặc build flag này
# Nếu dự án dùng relative path (./) thì base path này có thể không cần thiết,
# nhưng tốt nhất nên set để đảm bảo asset linking đúng.
ENV VITE_BASE_PATH=${BASE_PATH}
RUN npm run build

# Giai đoạn 2: Serve bằng Nginx
FROM nginx:1.25-alpine

# Copy kết quả build vào thư mục serve của Nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy file cấu hình Nginx custom (để hỗ trợ SPA và WASM)
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
