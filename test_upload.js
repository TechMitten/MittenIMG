const axios = require('axios');
const fs = require('fs');

async function test() {
  const base64Image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const data = {
    data: `data:image/png;base64,${base64Image}`,
    contentType: "image/png",
    name: "image.png"
  };
  try {
    const res = await axios.post("https://media.pollinations.ai/upload", data, {
      headers: { "Content-Type": "application/json" }
    });
    console.log("Status:", res.status);
    console.log("Data:", res.data);
  } catch (e) {
    console.log("Error:", e.response ? e.response.data : e.message);
  }
}
test();
