require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
// stripe setup
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const decoded = Buffer.from(process.env.FB_SECRET_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

const app = express();
const port = process.env.PORT || 3000;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middlewares
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ix21m2z.mongodb.net/?appName=Cluster0`;

// mongo client
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

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
    res.status(403).send({ message: "unauthorized access" });
  }
};

// mongo db starts here--------------------
const runDB = async () => {
  try {
    // await client.connect()
    // await db.command({ ping: 1 });
    // console.log(
    //   "Pinged the deployment. You successfully connected to MongoDB!"
    // );

    const db = client.db("style_decor");
    const usersColl = db.collection("users");
    const serviceColl = db.collection("services");
    const serviceCentersColl = db.collection("ServiceCenters");
    const bookingColl = db.collection("bookings");
    const paymentColl = db.collection("paymentsHistory");
    const decoratorColl = db.collection("decorators");

    // indexing----------duplication protection

    await paymentColl.createIndex(
      { bookingId: 1, transactionId: 1 },
      { unique: true }
    );

    await decoratorColl.createIndex({ decoratorEmail: 1 }, { unique: true });

    decoratorColl.createIndex({ applicationStatus: 1 });
    decoratorColl.createIndex({ isAvailable: 1 });
    decoratorColl.createIndex({ "serviceLocation.city": 1 });

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
        const decoded_email = req.decoded_email;
        console.log(decoded_email);

        const userData = await usersColl.findOne({ userEmail: decoded_email });
        if (!userData) {
          return res.status(404).send({ message: "no data found 💀" });
        }
        res.send(userData);
      } catch (error) {
        res.status(500).send({ message: "Server error" });
        console.error(error);
      }
    });

    // ----------booking data for decorators---------------------booking data for decorators-----------
    // ----------booking data for decorators----------- ----------booking data for decorators-----------

    app.get(
      "/booking/:decoratorId/decorator",
      verifyFBToken,
      async (req, res) => {
        try {
          const decoId = req.params.decoratorId;
          if (!decoId) {
            return res.status(403).send({ message: "invalid request" });
          }
          const bookings = await bookingColl
            .find({ assignedDecoratorId: decoId })
            .toArray();
          if (bookings.length === 0) {
            return res.status(404).send({ message: "no data found" });
          }
          res.send(bookings);
        } catch (error) {
          res.status(500).send({ message: "Server error" });
          console.error(error);
        }
      }
    );

    // decorator api------------decorator api---------decorator api-------------------decorator api---------

    app.post("/decorators", async (req, res) => {
      try {
        const applicationInfo = req.body;
        // console.log(applicationInfo.decoratorEmail);

        const alreadyExists = await decoratorColl.findOne({
          decoratorEmail: applicationInfo.decoratorEmail,
        });
        if (alreadyExists) {
          return res.send({ message: "Decorator accounts already exists" });
        }
        const postDecoResult = await decoratorColl.insertOne(applicationInfo);
        if (!postDecoResult.insertedId) {
          return res
            .status(400)
            .send({ message: "bad request, operation failed" });
        }
        res.send(postDecoResult);
        console.log(postDecoResult);
      } catch (error) {
        res.send(500).send({ message: "server error" });
      }
    });

    app.get("/decorators", verifyFBToken, async (req, res) => {
      try {
        const { applicationStatus, city } = req.query;
        const isAvailable = true;
        const query =
          Object.keys(req.query).length === 0
            ? {}
            : { applicationStatus, isAvailable, "serviceLocation.city": city };

        const decorators = await decoratorColl.find(query).toArray();
        if (decorators.length === 0) {
          return res.status(404).send({ message: "no data found" });
        }
        res.send(decorators);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "server error" });
      }
    });

    // ---------dashboard/manage-decorators--------

    app.patch("/decorator/:id", verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { action, userId } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid decorator id" });
        }

        if (userId && !ObjectId.isValid(userId)) {
          return res.status(400).send({ message: "Invalid user id" });
        }

        // ----disable--------------
        if (action === "disable") {
          const result = await decoratorColl.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                accountStatus: "disabled",
                isAvailable: false,
                disabledAt: new Date(),
              },
            }
          );
          return res.send(result);
        }

        // ---- enabling here----
        if (action === "enable") {
          const result = await decoratorColl.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                accountStatus: "active",
                isAvailable: true,
              },
              $unset: { disabledAt: "" },
            }
          );
          return res.send(result);
        }

        // ---- rejecting here ----
        if (action === "reject") {
          const result = await decoratorColl.updateOne(
            { _id: new ObjectId(id), applicationStatus: "pending" },
            {
              $set: {
                applicationStatus: "rejected",
                isVerified: false,
              },
            }
          );

          if (result.matchedCount === 0) {
            return res
              .status(404)
              .send({ message: "Decorator not found or already processed" });
          }

          return res.send({ message: "Application rejected" });
        }

        // ---- approving here ----
        if (action === "approve") {
          const decoratorResult = await decoratorColl.updateOne(
            {
              _id: new ObjectId(id),
              applicationStatus: { $in: ["pending", "rejected"] },
            },
            {
              $set: {
                applicationStatus: "approved",
                isVerified: true,
                approvedAt: new Date(),
              },
            }
          );

          if (decoratorResult.matchedCount === 0) {
            return res
              .status(404)
              .send({ message: "Decorator not found or already approved" });
          }

          const userResult = await usersColl.updateOne(
            { _id: new ObjectId(userId) },
            {
              $set: {
                role: "decorator",
                decoratorId: id,
                approvedAt: new Date().toLocaleDateString(),
              },
            }
          );

          return res.send({ decoratorResult, userResult });
        }

        res.status(400).send({ message: "Invalid action" });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // -------- on assigning decorators

    app.patch("/decorator/:id/assignment", verifyFBToken, async (req, res) => {
      try {
        const decoId = req.params.id;
        const bookingId = req.body.bookingId;

        if (!decoId || !bookingId) {
          return res.status(400).send({ message: "Invalid request" });
        }

        const decoUpdate = {
          $set: {
            isAvailable: false,
            currentBookingId: bookingId,
            updatedAt: new Date(),
          },
        };

        const resultDeco = await decoratorColl.updateOne(
          { _id: new ObjectId(decoId) },
          decoUpdate
        );

        const bookingUpdate = {
          $set: {
            assignedDecoratorId: decoId,
            status: "assigned",
            assignedAt: new Date(),
            updatedAt: new Date(),
          },
        };

        const resultBooking = await bookingColl.updateOne(
          { _id: new ObjectId(bookingId) },
          bookingUpdate
        );

        if (resultDeco.matchedCount === 0) {
          return res.status(404).send({ message: "no matching data found" });
        }
        if (resultDeco.modifiedCount === 0) {
          return res.status(400).send({ message: "No changes were applied" });
        }
        if (resultBooking.matchedCount === 0) {
          return res.status(404).send({ message: "no matching data found" });
        }
        if (resultBooking.modifiedCount === 0) {
          return res.status(400).send({ message: "No changes were applied" });
        }

        res.send({
          decoratorUpdate: `This decorator has been assigned to booking no. ${bookingId}`,
          bookingUpdate: "This booking has been assigned",
        });
        console.log(resultBooking, resultDeco);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // -------on confirming consultation---------

    app.patch(
      "/consultation/:bookingId/update",
      verifyFBToken,
      async (req, res) => {
        try {
          const id = req.params.bookingId;
          const { status, bookingType } = req.body;
          if (!id || bookingType !== "consultation") {
            return res.status(403).send({ message: "invalid request" });
          }
          const updateFields = {
            $set: {
              status: status,
              updatedAt: new Date(),
            },
          };
          const result = await bookingColl.updateOne(
            { _id: new ObjectId(id) },
            updateFields
          );

          res.send(result);
          console.log(result);
        } catch (error) {
          console.error(error);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

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

    app.get("/bookings/admin", verifyFBToken, async (req, res) => {
      try {
        const allBookings = await bookingColl.find().toArray();
        if (allBookings.length === 0) {
          return res.status(404).send({ message: "no data found" });
        }
        res.send(allBookings);
      } catch (error) {
        res.status(500).send({ message: "server error: insertion failed" });
        console.error(error);
      }
    });

    app.delete("/bookings/:bookingId", verifyFBToken, async (req, res) => {
      try {
        const bookingId = req.params.bookingId;
        if (!bookingId || !ObjectId.isValid(bookingId)) {
          return res.status(400).send({ message: "invalid request" });
        }
        const deleteBookingRes = await bookingColl.deleteOne({
          _id: new ObjectId(bookingId),
        });
        if (deleteBookingRes.deletedCount === 0) {
          return res.send({ message: "no data was deleted" });
        }
        res.send({ message: "Booking deleted seccessfully" }, deleteBookingRes);
      } catch (error) {
        res.status(500).send({ message: "server error: insertion failed" });
        console.error(error);
      }
    });

    app.get("/bookings/:email", verifyFBToken, async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(401).send({ message: "Unauthorized access" });
        }

        const decoded_email = req.decoded_email;
        if (email !== decoded_email) {
          return res.status(403).send({ message: "Forbidden request" });
        }
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

    // -----------payment history related api

    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.userEmail;
        const decoded_email = req.decoded_email;
        if (userEmail !== decoded_email) {
          return res.status(403).send({ message: "forbidden request" });
        }

        const paymentData = await paymentColl.find().toArray();
        res.send(paymentData);
      } catch (error) {
        res.status(500).send({ message: "server error" });
        console.error(error);
      }
    });

    // --------------------on payment success------------booking data update, payment data entry

    app.patch("/on-payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId) {
          return res.status(400).send({ message: "Invalid request" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).send({ message: "Payment not completed" });
        }

        const bookingId = session.metadata.bookingId;
        const transactionId = session.payment_intent;

        const bookingUpdate = await bookingColl.updateOne(
          { _id: new ObjectId(bookingId) },
          {
            $setOnInsert: {},
            $set: {
              status: "confirmed",
              paymentStatus: session.payment_status,
              transactionId,
              amountPaid: session.amount_total,
            },
          }
        );

        if (bookingUpdate.matchedCount === 0) {
          return res.status(404).send({ message: "Booking not found" });
        }

        await paymentColl.updateOne(
          {
            bookingId,
            transactionId,
          },
          {
            $setOnInsert: {
              bookingId,
              clientEmail: session.customer_email,
              transactionId,
              amountPaid: session.amount_total,
              currency: session.currency,
              paymentStatus: session.payment_status,
              serviceName: session.metadata.serviceName,
              paid_at: new Date(),
            },
          },
          { upsert: true }
        );

        res.send({
          message: "Payment processed successfully",
          transactionId,
        });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ message: "Server error: payment update failed" });
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

    app.get("/services", async (req, res) => {
      try {
        const result = await serviceColl.find().toArray();
        res.send(result);
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
runDB().catch(console.dir);

app.get("/", (req, res) => {
  res.send("STYLEDECOR -- Server Connected");
});

app.listen(port, () => {
  console.log("styleDecor is running at port:", port);
});

// if (process.env.NODE_ENV !== "production") {
//   app.listen(port, () => {
//     console.log(`Server running on port ${port}`);
//   });
// }

// // Export the app for Vercel
// module.exports = app;
