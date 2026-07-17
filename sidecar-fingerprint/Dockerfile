# BioCheck fingerprint sidecar (SourceAFIS)
# Build:  docker build -t biocheck/fp-sidecar:0.1.0 .
# Run:    docker run -e FP_SIDECAR_API_KEY=... -p 127.0.0.1:8081:8081 biocheck/fp-sidecar:0.1.0
# Production posture: never expose directly; HTTPS/mTLS termination in front,
# same isolated-host rules as the SeetaFace6 sidecar (docs/SEETAFACE6_INTEGRATION.md).

FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -q -B dependency:go-offline
COPY src ./src
RUN mvn -q -B package

FROM eclipse-temurin:17-jre
RUN useradd --system --no-create-home fpsidecar
WORKDIR /app
COPY --from=build /src/target/fp-sidecar-0.1.0.jar app.jar
COPY --from=build /src/target/lib ./lib
USER fpsidecar
EXPOSE 8081
# Read-only container FS is safe: the service never writes to disk.
ENTRYPOINT ["java", "-cp", "app.jar:lib/*", "com.biocheck.fpsidecar.Main"]
