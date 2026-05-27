namespace Demo {
  class Service {
    public void Run() {
      this.Helper();
      Util.Log("hi");
    }
    void Helper() { }
    static void Boot() { }
  }
  static class Util {
    public static void Log(string m) { }
  }
}
