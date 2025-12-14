require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ix21m2z.mongodb.net/?appName=Cluster0`;
const express = require("express");
const admin = require("firebase-admin");
const serviceAccount = require("./styledecor-firebase-adminsdk.json");

// stripe setup
const stripe = require("stripe")(process.env.STRIPE_SECRET);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const cors = require("cors");
const port = process.env.PORT || 3000;

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

const verifyFBToken = async (req, res, next) => {
  const authHeader = await req.headers.authorization;
  // console.log("access token", token);

  if (!authHeader) {
    return res.status(403).send({
      message: "unauthorized access! stay away from making such request",
    });
  }

  try {
    const token = authHeader.split(" ")[1];
    // console.log("access token-------", token);
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_email = decoded.email;

    next();
  } catch (err) {
    res.status(501).send({ message: "unauthorized access" });
  }
};

app.get("/", (req, res) => {
  res.send("STYLEDECOR -- Server Connected");
});

// mongo db starts here--------------------
const runDB = async () => {
  try {
    await client.connect();
    const db = client.db("style_decor");
    await db.command({ ping: 1 });
    console.log(
      "Pinged the deployment. You successfully connected to MongoDB!"
    );

    const usersColl = db.collection("users");
    const serviceColl = db.collection("services");
    const serviceCentersColl = db.collection("ServiceCenters");
    const bookingColl = db.collection("bookings");
    const paymentColl = db.collection("paymentsHistory");

    // indexing----------

    paymentColl.createIndex(
      { bookingId: 1, transactionId: 1 },
      { unique: true }
    );

    // USERS collection api
    app.post("/users", async (req, res) => {
      try {
        const userData = req.body;
        userData.createAt = new Date();

        const searchDuplicate = await usersColl.findOne({
          userEmail: userData.userEmail,
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

    app.get("/users", verifyFBToken, async (req, res) => {
      try {
        const userData = await usersColl.find().toArray();
        res.send(userData);
      } catch (error) {
        console.error(error);
        res.status(404).send({ message: "data not found" });
      }
    });

    app.get("/me", verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        const userData = await usersColl.findOne({ userEmail: email });
        if (!userData) {
          return res.status(403).send({ message: "Forbidden request! 💀" });
        }
        res.send(userData);
      } catch (error) {
        res.status(500).send({ message: "Server error" });
        console.error(error);
      }
    });

    // ------------booking api---------------

    app.post("/booking", verifyFBToken, async (req, res) => {
      try {
        const bookingInfo = req.body;
        const bookedService = await serviceColl.findOne({
          _id: new ObjectId(bookingInfo.serviceId),
        });
        if (!bookedService) {
          return res.status(404).send({
            message: "Service not found, maybe it is not active anymore",
          });
        }

        const unitPrice = parseFloat(bookedService.cost);
        const quantity = parseFloat(bookingInfo.quantity);

        if (isNaN(quantity) || quantity <= 0) {
          return res.status(400).send({ message: "inavlid unit format!" });
        }

        bookingInfo.payableAmount =
          bookingInfo.bookingType === "decoration" ? unitPrice * quantity : 0;
        bookingInfo.unitPrice =
          bookingInfo.bookingType === "decoration" ? unitPrice : 0;

        const insertData = await bookingColl.insertOne(bookingInfo);
        if (!insertData.insertedId) {
          return res.status(400).send({ message: "failed to insert data" });
        }
        res.send(insertData);
        console.log(insertData);
      } catch (error) {
        res.status(500).send({ message: "server error: insertion failed" });
        console.error(error);
      }
    });

    app.get("/bookings", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        const bookings = await bookingColl
          .find({ bookedByEmail: email })
          .toArray();
        if (bookings.length === 0) {
          return res.status(404).send({ message: "no data found" });
        }
        res.send(bookings);
      } catch (error) {
        res.status(500).send({ message: "server error" });
        console.error(error);
      }
    });

    app.patch("/on-payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId) {
          return res.status(400).send({ message: "invalid request" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== "paid") {
          return res.send({ message: "Invalid request" });
        }

        const paymentData = {
          bookingId: session.metadata.bookingId,
          clientEmail: session.customer_email,
          transactionId: session.payment_intent,
          amountPaid: session.amount_total,
          currency: session.currency,
          paymentStatus: session.payment_status,
          paid_at: new Date(),
        };

        const paymentInsertedResult = await paymentColl.insertOne(paymentData);
        if (!paymentInsertedResult.insertedId) {
          return res.send({ message: "Payment data insertion failed!" });
        }

        const alreadyPaid = await bookingColl.findOne({
          transactionId: session.payment_intent,
        });

        if (alreadyPaid) {
          return;
        }
        const bookingId = session.metadata.bookingId;

        const query = { _id: new ObjectId(bookingId) };
        const update = {
          $set: {
            status: "confirmed",
            paymentStatus: session.payment_status,
            transactionId: session.payment_intent,
            amountPaid: session.amount_total,
          },
        };

        const updateBooking = await bookingColl.updateOne(query, update);
        if (updateBooking.matchedCount === 0) {
          return res.status(404).send({ message: "Booking not found" });
        }

        res.send({
          updateInfo: updateBooking,
          transactionId: session.payment_intent,
          paymentInsertedResult,
        });
        console.log(session);
      } catch (error) {
        res
          .status(500)
          .send({ message: "server error: payment update failed" });

        console.error(error);
      }
    });

    // SERVICE related api

    app.post("/services", async (req, res) => {
      const serviceData = req.body;
      try {
        const result = await serviceColl.insertOne(serviceData);
        if (!result.insertedId) {
          return res.send({ message: "failed to add service" });
        }
        res.send(result);
        console.log(result);
      } catch (error) {
        res.status(500).send({ message: "server internal error" });
        console.error(error);
      }
    });

    app.get("/services", verifyFBToken, async (req, res) => {
      try {
        const result = await serviceColl.find().toArray();
        return res.send(result);
      } catch (error) {
        res.status(500).send({ message: "server internal error" });
        console.error(error);
      }
    });

    app.get("/service/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid object ID" });
        }

        const result = await serviceColl.findOne({ _id: new ObjectId(id) });
        if (!result) {
          return res.status(404).send({ message: "service not found" });
        }
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Server error" });
        console.error(error);
      }
    });

    // stripe api ------------------------

    app.post("/create-checkout-session", async (req, res) => {
      const bookingData = req.body;
      const amount = parseInt(bookingData.payableAmount) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "bdt",
              product_data: {
                name: bookingData.serviceName,
              },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        metadata: {
          bookingId: bookingData._id,
          serviceName: bookingData.serviceName,
        },
        customer_email: bookingData.bookedByEmail,
        mode: "payment",
        success_url: `${process.env.CLIENT_URL}/dashboard/on-payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/dashboard/on-payment-cancel`,
      });

      res.send({ url: session.url });
      console.log(session.url);
    });

    // -------------service centers api------------------

    app.get("/service-centers", async (req, res) => {
      try {
        const result = await serviceCentersColl.find().toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ message: "Server failed to load service-center data" });
      }
    });

    // closing here--------------
  } catch (err) {
    console.error(err);
  }
};
runDB();

app.listen(port, () => {
  console.log("styleDecor is running at port:", port);
});
