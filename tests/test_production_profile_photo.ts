import http from "http";
import fs from "fs";
import path from "path";

const BASE_URL = "http://127.0.0.1:3000";

function makeRequest(
  method: string,
  urlPath: string,
  body?: any,
  token?: string,
  headersExtra?: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any; rawBuffer?: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    let postData: Buffer;

    if (Buffer.isBuffer(body)) {
      postData = body;
    } else if (body) {
      postData = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    } else {
      postData = Buffer.alloc(0);
    }

    const headers: Record<string, string> = { ...headersExtra };
    if (body) {
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json";
      }
      headers["Content-Length"] = postData.length.toString();
    }
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const rawBuffer = Buffer.concat(chunks);
          const rawString = rawBuffer.toString("utf-8");
          try {
            const data = rawString ? JSON.parse(rawString) : {};
            resolve({ status: res.statusCode || 500, headers: res.headers, data, rawBuffer });
          } catch {
            resolve({ status: res.statusCode || 500, headers: res.headers, data: rawString, rawBuffer });
          }
        });
      }
    );

    req.on("error", (err) => reject(err));
    if (postData.length > 0) {
      req.write(postData);
    }
    req.end();
  });
}

function buildMultipartFormData(
  fieldName: string,
  fileName: string,
  mimeType: string,
  fileBuffer: Buffer
): { boundary: string; payload: Buffer } {
  const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const payload = Buffer.concat([
    Buffer.from(header, "utf-8"),
    fileBuffer,
    Buffer.from(footer, "utf-8")
  ]);

  return { boundary, payload };
}

// Valid 1x1 pixel JPEG image
const VALID_JPEG_BUFFER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x03, 0x02, 0x02, 0x03, 0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x04,
  0x03, 0x03, 0x04, 0x05, 0x08, 0x05, 0x05, 0x04, 0x04, 0x05, 0x0a, 0x07,
  0x07, 0x06, 0x08, 0x0c, 0x0a, 0x0c, 0x0c, 0x0b, 0x0a, 0x0b, 0x0b, 0x0d,
  0x0e, 0x12, 0x0f, 0x0d, 0x0e, 0x11, 0x0e, 0x0b, 0x0b, 0x10, 0x16, 0x10,
  0x11, 0x13, 0x14, 0x15, 0x15, 0x15, 0x0c, 0x0f, 0x17, 0x18, 0x16, 0x14,
  0x18, 0x12, 0x14, 0x15, 0x14, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
  0x00, 0xbf, 0x00, 0x7f, 0x00, 0xff, 0xd9
]);

async function runProductionProfilePhotoTests() {
  console.log("============================================================");
  console.log("RUNNING PRODUCTION PROFILE PHOTO TEST SUITE");
  console.log("============================================================");

  const ts = Date.now();
  const user1Name = `photo_user1_${ts}`;
  const user2Name = `photo_user2_${ts}`;
  const password = "Password123!";

  // 1. Register User 1 & User 2
  console.log("1. Registering User 1 & User 2...");
  const reg1 = await makeRequest("POST", "/api/auth/register", {
    username: user1Name,
    display_name: "Photo Test User 1",
    password
  });
  if (reg1.status !== 200 || !reg1.data.access_token) {
    throw new Error(`Registration 1 failed: ${JSON.stringify(reg1.data)}`);
  }
  const token1 = reg1.data.access_token;

  const reg2 = await makeRequest("POST", "/api/auth/register", {
    username: user2Name,
    display_name: "Photo Test User 2",
    password
  });
  if (reg2.status !== 200 || !reg2.data.access_token) {
    throw new Error(`Registration 2 failed: ${JSON.stringify(reg2.data)}`);
  }
  const token2 = reg2.data.access_token;
  console.log("✓ User 1 and User 2 registered successfully.");

  // 2. Test Invalid File Rejection (invalid file type / extension)
  console.log("\n2. Testing rejection of invalid file types (e.g. text/plain)...");
  const txtFormData = buildMultipartFormData(
    "file",
    "hack.txt",
    "text/plain",
    Buffer.from("Hello world script hack", "utf-8")
  );
  const badFileRes = await makeRequest("POST", "/api/auth/profile/picture", txtFormData.payload, token1, {
    "Content-Type": `multipart/form-data; boundary=${txtFormData.boundary}`
  });
  if (badFileRes.status !== 400) {
    throw new Error(`Expected 400 Bad Request for text file, got ${badFileRes.status}`);
  }
  console.log("✓ Invalid file type correctly rejected with 400 Bad Request.");

  // 3. Test Invalid File Rejection (corrupted magic bytes)
  console.log("\n3. Testing rejection of corrupted image bytes...");
  const fakeJpgFormData = buildMultipartFormData(
    "file",
    "fake.jpg",
    "image/jpeg",
    Buffer.from("This is not a real jpeg file header", "utf-8")
  );
  const corruptedRes = await makeRequest("POST", "/api/auth/profile/picture", fakeJpgFormData.payload, token1, {
    "Content-Type": `multipart/form-data; boundary=${fakeJpgFormData.boundary}`
  });
  if (corruptedRes.status !== 400) {
    throw new Error(`Expected 400 Bad Request for corrupted image bytes, got ${corruptedRes.status}`);
  }
  console.log("✓ Corrupted file content correctly rejected with 400 Bad Request.");

  // 4. Test File Size Limit Rejection (>5MB)
  console.log("\n4. Testing rejection of oversized files (>5MB)...");
  const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
  VALID_JPEG_BUFFER.copy(largeBuffer, 0, 0, VALID_JPEG_BUFFER.length);
  const largeFormData = buildMultipartFormData("file", "large.jpg", "image/jpeg", largeBuffer);
  const largeRes = await makeRequest("POST", "/api/auth/profile/picture", largeFormData.payload, token1, {
    "Content-Type": `multipart/form-data; boundary=${largeFormData.boundary}`
  });
  if (largeRes.status !== 400) {
    throw new Error(`Expected 400 Bad Request for >5MB file, got ${largeRes.status}`);
  }
  console.log("✓ Oversized file correctly rejected with 400 Bad Request.");

  // 5. Test Unauthorized Upload Rejection
  console.log("\n5. Testing rejection of unauthenticated photo upload...");
  const validFormData = buildMultipartFormData("file", "avatar.jpg", "image/jpeg", VALID_JPEG_BUFFER);
  const unauthRes = await makeRequest("POST", "/api/auth/profile/picture", validFormData.payload, undefined, {
    "Content-Type": `multipart/form-data; boundary=${validFormData.boundary}`
  });
  if (unauthRes.status !== 401) {
    throw new Error(`Expected 401 Unauthorized for upload without token, got ${unauthRes.status}`);
  }
  console.log("✓ Unauthenticated upload correctly rejected with 401 Unauthorized.");

  // 6. Test Valid Profile Photo Upload
  console.log("\n6. Testing valid profile photo upload for User 1...");
  const uploadRes = await makeRequest("POST", "/api/auth/profile/picture", validFormData.payload, token1, {
    "Content-Type": `multipart/form-data; boundary=${validFormData.boundary}`
  });
  if (uploadRes.status !== 200 || !uploadRes.data.profile_picture_url) {
    throw new Error(`Profile photo upload failed: ${JSON.stringify(uploadRes.data)}`);
  }
  const photoUrl = uploadRes.data.profile_picture_url;
  console.log(`✓ Photo uploaded successfully! Stored photo URL: ${photoUrl}`);

  // 7. Test User Profile Retrieval (/api/auth/me)
  console.log("\n7. Verifying profile_picture_url in /api/auth/me...");
  const meRes = await makeRequest("GET", "/api/auth/me", undefined, token1);
  if (meRes.status !== 200 || meRes.data.profile_picture_url !== photoUrl) {
    throw new Error(`GET /api/auth/me returned incorrect photo URL: ${JSON.stringify(meRes.data)}`);
  }
  console.log("✓ /api/auth/me retains stable profile_picture_url reference.");

  // 8. Test HTTP Image Serving from Server
  console.log(`\n8. Fetching uploaded image directly via HTTP GET ${photoUrl}...`);
  const serveRes = await makeRequest("GET", photoUrl);
  if (serveRes.status !== 200) {
    throw new Error(`Failed to serve uploaded image from ${photoUrl}, status code: ${serveRes.status}`);
  }
  if (!serveRes.rawBuffer || serveRes.rawBuffer.length === 0) {
    throw new Error(`Image served from ${photoUrl} was empty!`);
  }
  const contentType = String(serveRes.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("image/")) {
    throw new Error(`Expected Content-Type image/* for photo, got: ${contentType}`);
  }
  console.log(`✓ Uploaded image served successfully with HTTP 200 OK (${serveRes.rawBuffer.length} bytes, Content-Type: ${contentType}).`);

  // 9. Test Photo Persistence Across Re-login
  console.log("\n9. Testing photo persistence across user re-login...");
  const loginRes = await makeRequest("POST", "/api/auth/login", {
    username: user1Name,
    password
  });
  if (loginRes.status !== 200 || loginRes.data.user.profile_picture_url !== photoUrl) {
    throw new Error(`Re-login profile_picture_url mismatch: ${JSON.stringify(loginRes.data)}`);
  }
  console.log("✓ Re-login returned correct profile_picture_url.");

  // 10. Test User Isolation (User 2 has no photo, cannot change User 1's photo)
  console.log("\n10. Verifying user photo isolation...");
  const user2Me = await makeRequest("GET", "/api/auth/me", undefined, token2);
  if (user2Me.data.profile_picture_url !== null) {
    throw new Error(`User 2 unexpectedly had User 1's photo URL!`);
  }
  console.log("✓ User 2 profile photo remains isolated (null).");

  // 11. Test Deleting Profile Photo
  console.log("\n11. Testing DELETE /api/auth/profile/picture...");
  const deleteRes = await makeRequest("DELETE", "/api/auth/profile/picture", undefined, token1);
  if (deleteRes.status !== 200 || deleteRes.data.profile_picture_url !== null) {
    throw new Error(`DELETE photo failed: ${JSON.stringify(deleteRes.data)}`);
  }
  console.log("✓ Profile photo deleted successfully (profile_picture_url is now null).");

  // Verify deleted file is no longer served
  const deletedServeRes = await makeRequest("GET", photoUrl);
  if (deletedServeRes.status !== 404) {
    throw new Error(`Expected 404 Not Found for deleted photo, got ${deletedServeRes.status}`);
  }
  console.log("✓ Deleted photo file removed from server disk (404 Not Found).");

  console.log("\n============================================================");
  console.log("ALL PRODUCTION PROFILE PHOTO TESTS PASSED! 🎉");
  console.log("============================================================\n");
}

runProductionProfilePhotoTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
