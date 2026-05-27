defmodule Service do
  def run do
    helper()
  end

  defp helper do
    Enum.count([1, 2, 3])
  end
end
