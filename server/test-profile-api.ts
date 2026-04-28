import fetch from "node-fetch";
import express from "express";
import { authMiddleware, getProfile } from "./src/api/routes.js";

const testApp = express();
testApp.use(express.json());
testApp.get("/api/profile", authMiddleware, getProfile);

const server = testApp.listen(39876, async () => {
  console.log("Test server running on port 39876");
  
  // Test 1: No auth header
  console.log("\nTest 1: Request without auth header");
  const res1 = await fetch("http://localhost:39876/api/profile");
  console.log(`Status: ${res1.status}`);
  console.log(`Response: ${await res1.text()}`);
  
  // Test 2: Invalid auth header
  console.log("\nTest 2: Request with invalid auth header");
  const res2 = await fetch("http://localhost:39876/api/profile", {
    headers: { "Authorization": "Invalid token" }
  });
  console.log(`Status: ${res2.status}`);
  console.log(`Response: ${await res2.text()}`);
  
  // Test 3: Valid auth header
  console.log("\nTest 3: Request with valid auth header");
  const res3 = await fetch("http://localhost:39876/api/profile", {
    headers: { "Authorization": "Bearer test_token_123" }
  });
  console.log(`Status: ${res3.status}`);
  const data = await res3.json();
  console.log(`Response: ${JSON.stringify(data, null, 2)}`);
  
  // Verify required fields
  const requiredFields = ["id", "username", "email", "avatarUrl", "displayName", "createdAt"];
  const missingFields = requiredFields.filter(f => !(f in data));
  if (missingFields.length === 0) {
    console.log("\n✅ All required fields present");
  } else {
    console.log(`\n❌ Missing fields: ${missingFields.join(", ")}`);
  }
  
  server.close();
});
