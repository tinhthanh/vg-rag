# Giai đoạn 1: Build
FROM node:18-alpine as builder

# Nhận biến BASE_PATH từ docker build-args
ARG BASE_PATH=/vg-rag

WORKDIR /app

# Copy package files
COPY package*.json ./

# FIX: Xóa package-lock.json và node_modules để buộc npm giải quyết lại dependencies
# Điều này sửa lỗi thiếu @rollup/rollup-linux-x64-musl trên Alpine Linux
RUN rm -rf package-lock.json node_modules && npm install

# Copy source code
COPY . .

# Build dự án
ENV VITE_BASE_PATH=${BASE_PATH}
RUN npm run build

# Giai đoạn 2: Serve bằng Nginx
FROM nginx:1.25-alpine

# Copy kết quả build vào thư mục serve của Nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy file cấu hình Nginx custom
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
