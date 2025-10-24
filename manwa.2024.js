// 全局缓存密钥和 IV，避免重复生成
let cachedKeyMaterial = null;
const aesKey = "my2ecret782ecret"; // 建议从环境变量获取：env.AES_KEY
const iv = new TextEncoder().encode(aesKey.slice(0, 16));

// 初始化密钥（仅在 Worker 启动时执行一次）
async function initializeKey() {
  if (!cachedKeyMaterial) {
    cachedKeyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(aesKey),
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );
  }
  return cachedKeyMaterial;
}

async function decrypt(encData, keyMaterial) {
  try {
    return await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: iv },
      keyMaterial,
      encData
    );
  } catch (error) {
    throw new Error(`解密失败: ${error.message}`);
  }
}

async function decryptImage(encImageUrl, keyMaterial, request) {
  const startTotal = performance.now();
  let fetchTime = 0;
  let ttfbTime = 0;
  try {
    // 发起请求，最小化请求头
    const fetchStart = performance.now();
    const myRequest = new Request(encImageUrl, {
      headers: {
        "If-None-Match": request.headers.get("If-None-Match") || "",
        "If-Modified-Since": request.headers.get("If-Modified-Since") || "",
      },
    });

    const res = await fetch(myRequest);
    ttfbTime = performance.now() - fetchStart;
    if (!res.ok) {
      throw new Error(`请求失败: ${res.status} ${res.statusText}`);
    }

    // 获取 Content-Type 和元数据
    let contentType = res.headers.get("Content-Type") || "application/octet-stream";
    console.log(`源 Content-Type: ${contentType}, Cache-Status: ${res.headers.get("CF-Cache-Status") || "N/A"}`);
    const etag = res.headers.get("ETag") || null;
    const lastModified = res.headers.get("Last-Modified") || null;

    // 根据 URL 扩展名推断 Content-Type
    const url = new URL(encImageUrl);
    const ext = url.pathname.split(".").pop()?.toLowerCase();
    const mimeMap = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
    };
    if (ext && mimeMap[ext]) {
      contentType = mimeMap[ext];
    } else if (!contentType.startsWith("image/")) {
      console.warn(`源 Content-Type 非图像类型: ${contentType}, 使用默认 image/webp`);
      contentType = "image/webp";
    }

    // 获取数据
    fetchTime = performance.now() - fetchStart;
    const decryptStart = performance.now();
    const encData = await res.arrayBuffer();
    const decData = await decrypt(encData, keyMaterial);
    const decArray = new Uint8Array(decData);

    // 验证图像格式
    const isWebP = decArray.slice(0, 4).every((b, i) => [0x52, 0x49, 0x46, 0x46][i] === b);
    const isJPEG = decArray.slice(0, 2).every((b, i) => [0xFF, 0xD8][i] === b);
    const isPNG = decArray.slice(0, 8).every((b, i) => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A][i] === b);
    const isGIF = decArray.slice(0, 3).every((b, i) => [0x47, 0x49, 0x46][i] === b);
    if (contentType === "image/webp" && !isWebP) {
      console.warn("解密数据可能不是有效的 WebP 图片");
    } else if (contentType === "image/jpeg" && !isJPEG) {
      console.warn("解密数据可能不是有效的 JPEG 图片");
    } else if (contentType === "image/png" && !isPNG) {
      console.warn("解密数据可能不是有效的 PNG 图片");
    } else if (contentType === "image/gif" && !isGIF) {
      console.warn("解密数据可能不是有效的 GIF 图片");
    }

    // 记录性能
    const decryptTime = performance.now() - decryptStart;
    console.log(
      `TTFB: ${ttfbTime}ms, fetch 耗时: ${fetchTime}ms, 解密耗时: ${decryptTime}ms, ` +
      `总耗时: ${performance.now() - startTotal}ms, 图片大小: ${encData.byteLength} bytes`
    );

    // 创建响应
    return new Response(decData, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": "inline",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        ...(etag && { ETag: etag }),
        ...(lastModified && { "Last-Modified": lastModified }),
      },
    });
  } catch (error) {
    console.error(`解密图像错误: ${error.message}`);
    return new Response(`解密并返回图像时出错: ${error.message}`, { status: 500 });
  }
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    const imageUrl = decodeURIComponent(url.searchParams.get("imageUrl") || "");
    if (!imageUrl) {
      return new Response("缺少 imageUrl 参数", { status: 400 });
    }

    try {
      const keyMaterial = await initializeKey();
      return await decryptImage(imageUrl, keyMaterial, request);
    } catch (error) {
      console.error(`处理请求错误: ${error.message}`);
      return new Response(`处理请求时出错: ${error.message}`, { status: 500 });
    }
  }
  return new Response("Not Found", { status: 404 });
}
