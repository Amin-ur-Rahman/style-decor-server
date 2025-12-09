require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ix21m2z.mongodb.net/?appName=Cluster0`;
const express = require("express");

const app = express();
const cors = require("cors");
const port = process.env.PORT || 3000;

console.log("DB_USER:", process.env.DB_USER);
console.log("DB_PASS:", process.env.DB_PASS);
// mongo client
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// middlewares

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("STYLEDECOR -- Server Connected");
});

const runDB = async () => {
  try {
    await client.connect();
    const db = client.db("style_decor");
    await db.command({ ping: 1 });
    console.log(
      "Pinged the deployment. You successfully connected to MongoDB!"
    );

    const usersColl = db.collection("users");

    app.post("/users", async (req, res) => {
      try {
        const userData = req.body;

        const searchDuplicate = await usersColl.findOne({
          userEmail: userData.email,
        });
        if (searchDuplicate)
          return res.send({ message: "user already exists" });
        const postData = await usersColl.insertOne(userData);
        if (!postData.insertedId) {
          return res.send({ message: "Failed to insert user data" });
        }
        res.send(postData);
      } catch (error) {
        res.status(500).send(error);
      }
    });

    app.get("/users", async (req, res) => {
      try {
        const userData = await usersColl.find().toArray();
        res.send(userData);
      } catch (error) {
        console.error(error);
        res.status(404).send({ message: "data not found" });
      }
    });
  } catch (err) {
    console.error(err);
  }
};
runDB();

app.listen(port, () => {
  console.log("styleDecor is running at port:", port);
});
