FROM node:22-alpine
WORKDIR /app
# No runtime dependencies, so there's nothing to npm install.
COPY package.json ./
COPY src ./src
ENV PORT=7000
EXPOSE 7000
USER node
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "const s=process.env.TLS_CERT?'https':'http';require(s).get(s+'://127.0.0.1:'+process.env.PORT+'/manifest.json',{rejectUnauthorized:false},(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/server.js"]
