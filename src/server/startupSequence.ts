interface ListenServer {
  listen(port: number, host: string): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "listening", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "listening", listener: () => void): unknown;
}

export async function listenBeforeBootstrap(
  server: ListenServer,
  port: number,
  host: string,
  bootstrap: () => Promise<void>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  await bootstrap();
}
