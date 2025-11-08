# social-impact-hackathon-backend

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.1. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

# How to run server:

1. Copy .sample_env into .env and fill out the keys
 
    - `cp .sample_env .env`

2. Terminal 1:

    - `bun run start`

3. Terminal 2:

    - `lt --port 8080 --subdomain myapp`

4. Terminal 3:
    - `python client_test.py --phone +1112223333 --actually-call --url https://myapp.loca.lt`
